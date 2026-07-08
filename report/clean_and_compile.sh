#!/bin/bash

rm *.aux *.bbl *.bcf *.blg *.log *.out *.run.xml *.toc
pdflatex main.tex
biber main
pdflatex main.tex
pdflatex main.tex
