# Synthetic document fixtures

These files contain no real personal information. Seeded paper noise, fine text,
a test stamp, a signature curve and a QR with `EDO-ARTIFACT-READABILITY-2026` model
common document features. They demonstrate measured behavior on these exact
bytes, not guaranteed savings or clinical OCR quality on real passports.

`manifest.json` records SHA-256 and size. `qr.svg` is the reference QR matrix;
regenerate binaries with `pnpm --filter @edo/api exec ts-node --transpile-only
scripts/generate-artifact-fixtures.ts`. JPEG encoder versions can affect output;
tests use the committed fixtures. `multipage.pdf` contains three differently sized
pages; `transparent.png` exercises alpha. EXIF 1–8 fixtures are derived in tests.

Run `scripts/benchmark-approved-artifacts.ts` for size comparisons, all eight EXIF
raster comparisons and alpha. It needs Poppler `pdftoppm`; outputs are under root
`.cache/approved-artifacts/benchmark`. Raster comparison uses 300-pixel thumbnails
only to detect orientation; production images retain their full dimensions.
DCT stream equality tests independently prove direct JPEG bytes are unchanged.

QR verification uses Pillow and zxing-cpp in a disposable Python environment;
`qr.svg` can be regenerated with Python qrcode, error correction M, box 8, border 4.
