package com.scanner;

import org.bitcoinj.core.*;
import org.bitcoinj.params.MainNetParams;
import org.bitcoinj.script.Script;
import org.bitcoinj.script.ScriptException;
import org.bitcoinj.utils.BlockFileLoader;

import java.io.*;
import java.nio.file.*;
import java.util.*;

/**
 * Scans the first N blocks of the Bitcoin main net (from a Bitcoin Core blocks/ dir),
 * reconstructs the UTXO set INCREMENTALLY — one block at a time, as a node would —
 * and after EACH processed block rewrites a snapshot of address -> available
 * balance (satoshis) to a TSV file.
 *
 * The snapshot is written ATOMICALLY (temp file + atomic rename), so a concurrent
 * reader (the oracle daemon) never observes a half-written file: every read sees a
 * complete, consistent UTXO set as of some processed block height.
 *
 * Scanning stops at `maxBlocks` (default 131000); once reached, the final snapshot
 * on disk is complete and the process exits.
 *
 * Supports Bitcoin Core 0.28+ block file obfuscation (xor.dat).
 *
 * Usage:
 *   java oracle.UtxoScanner <blocksDir> <outputSnapshot.txt> [maxBlocks=131000]
 *   e.g. java oracle.UtxoScanner ~/.bitcoin/blocks utxo_snapshot.txt 131000
 */
public class UtxoScanner {

    // outpoint "txid:index" -> (owner address string, value in satoshis)
    private final Map<String, String> utxoOwner = new HashMap<>();
    private final Map<String, Long>   utxoValue = new HashMap<>();
    // address string -> cumulative available balance (satoshis)
    private final Map<String, Long>   balances  = new HashMap<>();
    // dedupe in case block files overlap or contain duplicate-hash blocks
    private final Set<Sha256Hash>     seenBlocks = new HashSet<>();

    private final NetworkParameters params = MainNetParams.get();

    public static void main(String[] args) throws Exception {
        if (args.length < 2) {
            System.err.println("Usage: UtxoScanner <blocksDir> <out.txt> [maxBlocks]");
            System.exit(1);
        }
        File blocksDir = new File(args[0]);
        String outPath = args[1];
        int maxBlocks  = args.length >= 3 ? Integer.parseInt(args[2]) : 131_000;

        new UtxoScanner().run(blocksDir, outPath, maxBlocks);
    }

    private void run(File blocksDir, String outPath, int maxBlocks) throws IOException {
        Context.getOrCreate(params); // bitcoinj 0.15+ needs a thread-local Context

        // ── read xor.dat if present (Bitcoin Core 0.28+) ──────────────────────
        byte[] xorKey = readXorKey(blocksDir);
        if (xorKey != null) {
            System.out.printf("xor.dat found (%d bytes) — block files will be deobfuscated%n",
                    xorKey.length);
        } else {
            System.out.println("no xor.dat found — assuming unobfuscated block files");
        }

        List<File> rawFiles = blockFiles(blocksDir);
        if (rawFiles.isEmpty()) {
            System.err.println("No blk*.dat files found in " + blocksDir);
            return;
        }

        // ── if XOR key present, deobfuscate each file to a temp copy ──────────
        // BlockFileLoader needs real File handles, so we write decrypted copies
        // to a temp directory and delete them when done.
        List<File> filesToScan;
        File tempDir = null;
        if (xorKey != null) {
            tempDir = Files.createTempDirectory("btc_scanner_").toFile();
            filesToScan = deobfuscateFiles(rawFiles, xorKey, tempDir);
            System.out.println("deobfuscated files written to " + tempDir);
        } else {
            filesToScan = rawFiles;
        }

        try {
            // scanFiles now writes the snapshot after EACH block (atomically)
            scanFiles(filesToScan, maxBlocks, outPath);
        } finally {
            // always clean up temp files even if an exception occurs
            if (tempDir != null) {
                for (File f : tempDir.listFiles()) f.delete();
                tempDir.delete();
                System.out.println("temp files cleaned up");
            }
        }

        // final write to guarantee the on-disk file matches the last processed block
        writeSnapshotAtomic(outPath);
        System.out.printf("DONE: %d live utxos, %d addresses%n",
                utxoValue.size(), balances.size());
    }

    // ── XOR helpers ───────────────────────────────────────────────────────────

    /**
     * Reads xor.dat from the blocks directory.
     * Returns null if the file does not exist (pre-0.28 Bitcoin Core).
     */
    private byte[] readXorKey(File blocksDir) throws IOException {
        File xorFile = new File(blocksDir, "xor.dat");
        if (!xorFile.exists()) return null;
        return Files.readAllBytes(xorFile.toPath());
    }

    /**
     * XORs the contents of each blk*.dat file with the key (cycling),
     * writes the result to a temp file, and returns the list of temp files
     * in the same order.
     */
    private List<File> deobfuscateFiles(List<File> files, byte[] xorKey, File tempDir)
            throws IOException {
        List<File> result = new ArrayList<>();
        for (File src : files) {
            File dst = new File(tempDir, src.getName());
            byte[] data = Files.readAllBytes(src.toPath());
            xorInPlace(data, xorKey);
            Files.write(dst.toPath(), data);
            result.add(dst);
        }
        return result;
    }

    /**
     * XORs data in-place with the key, cycling the key as needed.
     * Bitcoin Core uses a simple cycling XOR: data[i] ^= key[i % key.length].
     */
    private void xorInPlace(byte[] data, byte[] xorKey) {
        for (int i = 0; i < data.length; i++) {
            data[i] ^= xorKey[i % xorKey.length];
        }
    }

    // ── block scanning ────────────────────────────────────────────────────────

    private void scanFiles(List<File> files, int maxBlocks, String outPath) throws IOException {
        BlockFileLoader loader = new BlockFileLoader(params, files);
        int processed = 0;

        for (Block block : loader) {
            if (processed >= maxBlocks) break;
            Sha256Hash h = block.getHash();
            if (!seenBlocks.add(h)) continue; // skip duplicates/already-seen

            try {
                processBlock(block);
            } catch (Exception e) {
                // a malformed/partial trailing block at EOF can throw; log and stop cleanly
                System.err.println("Stopped at block #" + processed + " (" + e + ")");
                break;
            }

            processed++;

            // INCREMENTAL: after each block, publish the current UTXO balances so a
            // reader always sees the set "as of the last processed block". The write
            // is atomic, so the reader never catches a partial file.
            writeSnapshotAtomic(outPath);

            if (processed % 10_000 == 0) {
                System.out.printf("processed %d blocks | %d utxos | %d addresses%n",
                        processed, utxoValue.size(), balances.size());
            }
        }

        System.out.printf("scanned %d blocks%n", processed);
    }

    private void processBlock(Block block) {
        List<Transaction> txs = block.getTransactions();
        if (txs == null) return;

        for (Transaction tx : txs) {
            // 1) spend inputs (skip coinbase, which has no real prevout)
            if (!tx.isCoinBase()) {
                for (TransactionInput in : tx.getInputs()) {
                    TransactionOutPoint op = in.getOutpoint();
                    String key = op.getHash().toString() + ":" + op.getIndex();
                    String owner = utxoOwner.remove(key);
                    Long val     = utxoValue.remove(key);
                    if (owner != null && val != null) {
                        credit(owner, -val); // remove spent value from the address balance
                    }
                    // if not found, the prevout pointed at a non-address output we never tracked
                }
            }

            // 2) create outputs
            String txid = tx.getTxId().toString();
            List<TransactionOutput> outs = tx.getOutputs();
            for (int i = 0; i < outs.size(); i++) {
                TransactionOutput out = outs.get(i);
                String addr = addressOf(out.getScriptPubKey());
                if (addr == null) continue;          // OP_RETURN, bare multisig, non-standard
                long value = out.getValue().value;   // satoshis
                if (value <= 0) continue;
                String key = txid + ":" + i;
                utxoOwner.put(key, addr);
                utxoValue.put(key, value);
                credit(addr, value);
            }
        }
    }

    /** Extract a single canonical address string, or null if the output isn't addressable. */
    private String addressOf(Script script) {
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

    /**
     * Atomically (re)write the snapshot: write the full balance map to a temp file
     * in the SAME directory, then atomically rename it over the target. A concurrent
     * reader therefore always opens either the old complete file or the new complete
     * file — never a half-written one.
     *
     * The temp file must be on the same filesystem as the target for the rename to be
     * atomic, which is why it is created in the target's parent directory.
     */
    private void writeSnapshotAtomic(String outPath) throws IOException {
        Path target = Paths.get(outPath);
        Path tmp = Paths.get(outPath + ".tmp");   // sibling temp file, same directory
        try (BufferedWriter w = Files.newBufferedWriter(tmp)) {
            for (Map.Entry<String, Long> e : balances.entrySet()) {
                if (e.getValue() <= 0) continue;
                w.write(e.getKey());
                w.write('\t');
                w.write(Long.toString(e.getValue()));
                w.write('\n');
            }
        }
        Files.move(tmp, target, StandardCopyOption.REPLACE_EXISTING);  // atomic on Linux
    }

    /** Collect blk00000.dat, blk00001.dat, ... in order. */
    private List<File> blockFiles(File dir) {
        List<File> files = new ArrayList<>();
        for (int i = 0; ; i++) {
            File f = new File(dir, String.format("blk%05d.dat", i)); // Examples: 0-> 00000, 1-> 00001
            if (!f.exists()) break;
            files.add(f);
        }
        return files;
    }
}