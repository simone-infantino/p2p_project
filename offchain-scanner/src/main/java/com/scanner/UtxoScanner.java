package com.scanner;

import org.bitcoinj.core.*;
import org.bitcoinj.params.MainNetParams;
import org.bitcoinj.script.Script;
import org.bitcoinj.script.ScriptException;
import org.bitcoinj.utils.BlockFileLoader;

import java.io.*;
import java.nio.file.*;
import java.util.*;

//the scanner processes a block at a time, updating the snapshot .txt file (name passed as a parameter).
//the scanning ends at max_blocks (we make sure to pass 131000 for this parameter)

public class UtxoScanner {

    // outpoint "txid:index" -> (owner address string, value in satoshis)
    private final Map<String, String> utxo_owner = new HashMap<>();
    private final Map<String, Long>   utxo_value = new HashMap<>();
    //address, value mapping
    private final Map<String, Long>   balances  = new HashMap<>();
    //contingency
    private final Set<Sha256Hash>     seen_blocks = new HashSet<>();

    private final NetworkParameters params = MainNetParams.get();

    private static final long POLL_MS = 5_000;


    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: UtxoScanner <blocks_directory> <out.txt> [max_blocks]");
            System.exit(1);
        }
        File blocks_directory = new File(args[0]);
        String out_path = args[1];
        int max_blocks  = args.length >= 3 ? Integer.parseInt(args[2]) : 131_000;

        new UtxoScanner().run(blocks_directory, out_path, max_blocks);
    }

    private void run(File blocks_directory, String out_path, int max_blocks) throws IOException, InterruptedException {
        Context.getOrCreate(params);

        byte[] xor_key = read_xor_key(blocks_directory);
        if (xor_key != null)
            System.out.println("xor.dat found, deobfuscating block files");
        else
            System.out.println("no xor.dat found, will proceed assuming block files are not obfuscated");

        //cache of already-deobfuscated files and their size
        Map<String, File> deob_cache = new HashMap<>();
        Map<String, Long> size_cache = new HashMap<>();
        File temp_directory = (xor_key != null)
                ? Files.createTempDirectory("btc_scanner_").toFile()
                : null;

        int processed = 0;
        try {
            while (processed < max_blocks) {
                List<File> raw_files = block_files(blocks_directory);
                if (raw_files.isEmpty()) {
                    System.err.println("no blk*.dat files found in " + blocks_directory);
                    return;
                }

                //re-deobfuscate only files that are new or have grown since last pass
                List<File> files_to_scan = new ArrayList<>();
                if (xor_key != null) {
                    for (File src : raw_files) {
                        long curSize = src.length();
                        Long knownSize = size_cache.get(src.getName());
                        if (knownSize == null || knownSize != curSize) {
                            File dst = new File(temp_directory, src.getName());
                            byte[] data = Files.readAllBytes(src.toPath());
                            xor_function(data, xor_key);
                            Files.write(dst.toPath(), data);
                            deob_cache.put(src.getName(), dst);
                            size_cache.put(src.getName(), curSize);
                        }
                        files_to_scan.add(deob_cache.get(src.getName()));
                    }
                } else {
                    files_to_scan = raw_files;
                }

                int before = processed;
                processed = scan_files(files_to_scan, max_blocks, out_path, processed);

                if (processed >= max_blocks) break;               // reached the cap -> done

                if (processed == before) {                        // nothing new this pass
                    System.out.printf("caught up at %d blocks; waiting for new blocks...%n", processed);
                    Thread.sleep(POLL_MS);
                }
            }
        } finally {
            if (temp_directory != null) {
                for (File f : temp_directory.listFiles()) f.delete();
                temp_directory.delete();
                System.out.println("temp files deleted");
            }
        }

        write_snapshot(out_path);
        System.out.printf("check: %d live utxos, %d addresses%n", utxo_value.size(), balances.size());
    }

    //helpers

    private byte[] read_xor_key(File blocks_directory) throws IOException {
        File xor_file = new File(blocks_directory, "xor.dat");
        if (!xor_file.exists()) return null;
        return Files.readAllBytes(xor_file.toPath());
    }

    //bitcoin core uses the key bytes in a cyclic manner
    private void xor_function(byte[] data, byte[] xor_key) {
        for (int i = 0; i < data.length; i++) {
            data[i] ^= xor_key[i % xor_key.length];
        }
    }

    private int scan_files(List<File> files, int max_blocks, String out_path, int processed) throws IOException {
        BlockFileLoader loader = new BlockFileLoader(params, files);

        for (Block block : loader) {
            if (processed >= max_blocks) break;
            Sha256Hash h = block.getHash();
            if (!seen_blocks.add(h)) continue;   //skip blocks handled in a previous check

            try {
                process_block(block);
            } catch (Exception e) {
                //in case we read the block mid-writing by bitcoin core
                System.err.println("stopped this pass at block " + processed + ". error: " + e);
                break;
            }

            processed++;
            write_snapshot(out_path);

            if (processed % 10_000 == 0) {
                System.out.printf("processed %d blocks | %d utxos | %d addresses%n",
                        processed, utxo_value.size(), balances.size());
            }
        }
        return processed;
    }

    private void process_block(Block block) {
        List<Transaction> txs = block.getTransactions();
        if (txs == null) return;

        //the following two for loops manage the utxo set of the found addresses
        for (Transaction tx : txs) {
            if (!tx.isCoinBase()) {
                for (TransactionInput in : tx.getInputs()) {
                    TransactionOutPoint op = in.getOutpoint();
                    String key = op.getHash().toString() + ":" + op.getIndex();
                    String owner = utxo_owner.remove(key);
                    Long val = utxo_value.remove(key);
                    if (owner != null && val != null)
                        credit(owner, -val);
                }
            }

            String txid = tx.getTxId().toString();
            List<TransactionOutput> output = tx.getOutputs();
            for (int i = 0; i < output.size(); i++) {
                TransactionOutput out = output.get(i);
                String addr = extract_address(out.getScriptPubKey());
                if (addr == null) continue;          //there could be scripts we can't work on, like OP_RETURN, non-standard, etc.
                long value = out.getValue().value;
                if (value <= 0) continue;
                String key = txid + ":" + i;
                utxo_owner.put(key, addr);
                utxo_value.put(key, value);
                credit(addr, value);
            }
        }
    }

    private String extract_address(Script script) {
        try {
            // forcePayToPubKey=true: derive the address from a raw pubkey (P2PK), common pre-2012
            Address a = script.getToAddress(params, true);
            return a.toString();
        } catch (ScriptException e) {
            return null;
        }
    }

    private void credit(String addr, long delta) {
        long updated = balances.getOrDefault(addr, 0L) + delta;
        if (updated == 0) balances.remove(addr);
        else balances.put(addr, updated);
    }

    //snapshot updating. It creates a temporary files and overwrites the old snapshot with its content
    private void write_snapshot(String out_path) throws IOException {
        Path target = Paths.get(out_path);
        Path tmp = Paths.get(out_path + ".tmp");
        try (BufferedWriter w = Files.newBufferedWriter(tmp)) {
            for (Map.Entry<String, Long> e : balances.entrySet()) {
                if (e.getValue() <= 0) continue;
                w.write(e.getKey());
                w.write('\t');
                w.write(Long.toString(e.getValue()));
                w.write('\n');
            }
        }
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);  //atomic on Linux, so there are no errors while working with the oracle daemon
    }

    private List<File> block_files(File dir) {
        List<File> files = new ArrayList<>();
        for (int i = 0; ; i++) {
            File f = new File(dir, String.format("blk%05d.dat", i)); //examples: 0-> 00000, 1-> 00001
            if (!f.exists()) break;
            files.add(f);
        }
        return files;
    }
}