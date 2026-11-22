| kernel | instructions plain / packed | performance: cycles plain / packed | speedup | baseline | turbo | deep |
|---|---:|---:|---:|---:|---:|---:|
| brighten 2048 bytes (saturating add) (`25_pixel_blend`) | 20,484 / 2,308 | 25,616 / 2,363 | **10.8x** | 10.4x | 10.9x | 11.1x |
| blend 2048 bytes (rounded average) (`25_pixel_blend`) | 22,532 / 2,308 | 24,635 / 2,363 | **10.4x** | 10.4x | 10.5x | 12.1x |
| motion search, 24 candidates x 256 pixels (SAD) (`26_motion_search`) | 63,355 / 4,988 | 77,113 / 5,121 | **15.1x** | 15.1x | 15.1x | 16.7x |
| int8 layer, 8 neurons x 512 inputs (dot products) (`27_int8_dot`) | 32,840 / 3,162 | 66,539 / 3,397 | **19.6x** | 11.9x | 15.9x | 17.5x |
| transform 256 vertices by a 4 x 4 Q15 matrix (`28_fixed_point`) | 19,976 / 4,367 | 49,052 / 4,652 | **10.5x** | 4.3x | 7.0x | 9.9x |
| audio gain on 2048 Q15 samples (`28_fixed_point`) | 18,445 / 2,578 | 35,559 / 2,634 | **13.5x** | 8.0x | 11.2x | 12.5x |
| **geometric mean** | | | **13.0x** | 9.3x | 11.4x | 13.0x |

Cycles between the two rdcycle reads around each version (the model, predictor on; the RTL of every build agrees cycle for cycle).
