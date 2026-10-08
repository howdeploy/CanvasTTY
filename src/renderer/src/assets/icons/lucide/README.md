# Lucide UI icons

These SVG files are unmodified icons downloaded from the official
[`lucide-icons/lucide`](https://github.com/lucide-icons/lucide) repository on
2026-08-04, with menu and Settings navigation additions fetched from the same
source on 2026-08-30 and canvas material additions on 2026-09-28.
They are vendored as local assets so CanvasTTY does not need to
execute or fetch an icon package from npm.

The files are used as CSS masks, which lets interface actions inherit the
surrounding text color without modifying the SVG geometry. Brand/provider
marks live separately under `assets/providers` and are never recolored.

Lucide is licensed under the ISC License.
