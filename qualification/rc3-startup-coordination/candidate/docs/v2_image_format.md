# eufy `v2_eufysecurity:` image format — and how to decode it without a key

Reverse-engineered for eufy app v6 (HomeBase 3 / unified eufy Security app).
**TL;DR: it is NOT encrypted in any meaningful sense — only the JPEG *header* is
scrambled. Discard it, splice on a fresh standard header, and the image renders.
No key, no E2E, no cipher.**

## Where the blob comes from

There are **two separate image paths** — only the HTTP one produces a `v2_` blob:

| Path | Source | What you get | Decode needed? |
|---|---|---|---|
| **HTTP** | GET the push `pic_url` | `v2_eufysecurity:…` (header-scrambled) | yes (this doc) |
| **P2P** | station `image download` event | plain JPEG, full-res | no — already an image |

`pic_url` itself is just a plain HTTPS URL; **the `v2_` blob is the HTTP response body** when you fetch it:

```
push message ──► pic_url = https://security-app-<REGION>.eufylife.com/v1/s/g/<TOKEN>
                     │  HTTP GET
                     ▼
   response body = v2_eufysecurity:<STATION_SERIAL>:<10-DIGIT-PKT>:<binary payload>
```

> Note: the P2P path returns clean JPEGs at **different** dimensions than the v2 blob for the same
> camera — so you can't use P2P sizes to decode v2.

## Wire format

```
v2_eufysecurity : <STATION_SERIAL> : <10-DIGIT-PKT> : <binary payload>
└──── magic ────┘ └── e.g. T8… ───┘ └─ packet id ─┘ └── the image ──┘
```

Split on the **first 3 colons only** — the 4th field is raw binary and may itself contain `0x3A` (`:`).

## The binary payload — head-only scramble

```
            ┌──────── ENCRYPTED (~286 bytes) ────────┐┌──────────── PLAINTEXT JPEG ────────────┐
 byte 0                                            ~286                                       end
   │                                                  │                                          │
   ▼                                                  ▼                                          ▼
   ┌──────────────────────────────────────────────────┬──────────────────────────────────────────┐
   │  AES-GCM-scrambled JPEG header:                   │  normal, untouched JPEG:                   │
   │    • SOI                                          │    • rest of DHT (Huffman tables)          │
   │    • APP0 / JFIF                                  │    • SOS  (start of scan)                  │
   │    • DQT  (quantization tables)                   │    • ░░░ entropy-coded pixel data ░░░       │
   │    • SOF  ◄── image WIDTH & HEIGHT (now lost)     │       ...the whole picture...              │
   │    • start of DHT                                 │    • EOI  (FF D9)                           │
   └──────────────────────────────────────────────────┴──────────────────────────────────────────┘
                                                      ▲
                            splice point: the standard baseline marker
                            FF C4 00 1F 01  (DC-chrominance Huffman table)
                            = first readable byte; everything after is plain JPEG (~95%+ of the file)
```

The scramble is AES-256-GCM (AAD `"eufy security"`) — but you never need to break it, because the only
useful things it hides are the quantization tables (a tiny quality/colour difference if you substitute
standard ones) and the **image dimensions**.

## Decode (no key)

```
1. payload    = response body after the 3rd ':'
2. tail       = payload[ payload.indexOf(FF C4 00 1F 01) : ]      # the plaintext JPEG
3. header     = a freshly built standard baseline JPEG header (SOI+APP0+DQT+SOF[W×H]+DHT)
4. image      = header ++ tail                                     # a valid JPEG → renders
```

The only unknowns are **W, H, and chroma subsampling**, because the SOF was in the scrambled head.
eufy uses **non-standard sizes** (e.g. 288×176, 552×408, 1272×728), so recover them from the pixels:

- **Width** = the value that minimises mean row-to-row difference. A wrong width shears the image (the
  picture "runs diagonally down"); the correct width makes rows line up. Sweep candidate widths and take
  the minimum.
- **Height** = grow the frame until the decoder hits the embedded EOI and errors ("unexpected `FF D9`");
  the largest height that still decodes is the true height.
- **Subsampling** ∈ {4:2:0, 4:2:2, 4:4:4} — pick the one with the least colour speckle (wrong subsampling
  gives saturated green/magenta blocks). Most images are 4:2:0; some snapshots are 4:4:4.

> Caveat: the EXIF orientation tag was also in the scrambled head, so some reconstructed images (e.g. from
> doorbells) come out rotated 90°. The pixels are correct; only the display-orientation hint is lost.
