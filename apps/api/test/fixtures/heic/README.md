# Synthetic HEIC/HEVC fixtures

No private documents or personal information. `document.heic` contains synthetic
fine text, a stamp/signature and the real QR `EDO-ARTIFACT-READABILITY-2026`.
`orientation-1..8.heic` exercise HEIF irot/imir; `exif-only.heic` has Orientation 6
only in EXIF, with no primary container transform. `display-p3.heic` carries a
Display P3 ICC profile. `alpha.heic` has transparency. `multiple.heic` deliberately
contains two top-level images and must be rejected. Sizes/hashes: `manifest.json`.

Tests decode these actual HEVC files; they do not mock HEIC with AVIF or PNG.
The runtime requires `heif-convert` (included in the API image via libheif-tools).
Run `pnpm --filter @edo/api exec vitest run test/heic-upload.spec.ts`.

Regeneration needs HEVC-capable `heif-enc` **1.23 or newer**, Python Pillow and
system libheif. Older heif-enc may silently ignore rotate/flip options.
`pnpm --filter @edo/api exec ts-node --transpile-only scripts/generate-heic-fixtures.ts`
creates the binaries and manifest; scratch files remain in `.cache/heic`.
Alternatively set `HEIF_ENCODER_CONTAINER` to a local image containing a recent
heif-enc (for example node:22-alpine plus `apk add --no-cache libheif-tools`).
The generator mounts only this worktree, runs offline as the current uid/gid.
The fixture-only `add-heic-exif-fixture.py` uses the public libheif C API because
the CLI normally converts EXIF orientation into irot during encoding.

`benchmark-heic-uploads.ts` writes WebP/PNG and size/quality measurements under
`.cache/heic/benchmark`. See `docs/integrations/edo-heic-uploads.md` for the
algorithm and limits. A smaller file is accepted only if the full-resolution
quality guard passes; no fixed percentage is asserted. QR reading was verified
separately with zxing-cpp/Pillow. Those Python packages are fixture tooling,
not API or OCR runtime dependencies.
