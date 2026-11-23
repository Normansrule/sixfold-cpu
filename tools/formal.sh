#!/usr/bin/env bash
# make formal: prove the Sixfold core against the RISC-V specification with riscv-formal (formal/README.md).
#   tools/formal.sh                 every check in formal/checks.cfg, performance build
#   tools/formal.sh --baseline      the same on the baseline build
#   tools/formal.sh --only 'insn_add_*'   a subset (shell pattern on the check name)
# Needs: SymbiYosys (sby), Yosys, a solver (Bitwuzla), git, and build/sv2v (make build/sv2v). Results and
# counterexample traces: build/formal/<build>/checks/<check>/.
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$PWD
BUILD=performance; ONLY='*'; JOBS=$(nproc)
while [ $# -gt 0 ]; do
  case "$1" in
    --baseline) BUILD=baseline ;;
    --only) ONLY="$2"; shift ;;
    -j) JOBS="$2"; shift ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac; shift
done

RVF=build/riscv-formal
RVF_COMMIT=c992aa6   # pinned: the version these results were produced with
if [ ! -d "$RVF/.git" ]; then
  git clone -q https://github.com/YosysHQ/riscv-formal.git "$RVF"
fi
git -C "$RVF" checkout -q "$RVF_COMMIT"

OUT=build/formal/$BUILD
CORE_DIR=$RVF/cores/sixfold_$BUILD
rm -rf "$CORE_DIR" "$OUT"
mkdir -p "$CORE_DIR" "$OUT"

# The core, flattened to plain Verilog with the formal ports and the ALTOPS stand-ins switched on
DEFS="-DRISCV_FORMAL -DRISCV_FORMAL_ALTOPS"
[ "$BUILD" = baseline ] && DEFS="$DEFS -DBASELINE"
./build/sv2v $DEFS $(grep -v -e Scratchpad -e Riscv64_top src/sources.f) > "$CORE_DIR/sixfold_core.v"
cp formal/wrapper.sv "$CORE_DIR/wrapper.sv"
if [ "$BUILD" = baseline ]; then sed -i '1i `define BASELINE' "$CORE_DIR/wrapper.sv"; fi
sed -e "s#@WRAPPER@#@basedir@/cores/@core@/wrapper.sv#" -e "s#@CORE@#@basedir@/cores/@core@/sixfold_core.v#" \
  formal/checks.cfg > "$CORE_DIR/checks.cfg"

(cd "$CORE_DIR" && python3 ../../checks/genchecks.py > /dev/null)
cd "$CORE_DIR/checks"
CHECKS=$(ls -d */ 2>/dev/null | tr -d / ; ls *.sby | sed 's/\.sby$//')
CHECKS=$(printf '%s\n' $CHECKS | sort -u)
SELECTED=()
for c in $CHECKS; do case "$c" in $ONLY) SELECTED+=("$c") ;; esac; done
echo "riscv-formal $RVF_COMMIT, $BUILD build: ${#SELECTED[@]} checks, $JOBS at a time"
start=$(date +%s)
printf '%s\n' "${SELECTED[@]}" | xargs -P "$JOBS" -I{} sh -c 'sby -f {}.sby > /dev/null 2>&1; echo {}' > /dev/null || true

pass=0; fail=0; other=0; : > "$ROOT/$OUT/summary.txt"
for c in "${SELECTED[@]}"; do
  status=$(cat "$c/status" 2>/dev/null | awk '{print $1}')
  case "$status" in
    PASS) pass=$((pass+1)) ;;
    FAIL) fail=$((fail+1)); echo "FAIL  $c   trace: $(ls "$c"/engine_*/trace*.vcd 2>/dev/null | head -1)" | tee -a "$ROOT/$OUT/summary.txt" ;;
    *)    other=$((other+1)); echo "${status:-ERROR} $c   log: $c/logfile.txt" | tee -a "$ROOT/$OUT/summary.txt" ;;
  esac
done
secs=$(( $(date +%s) - start ))
cp -r . "$ROOT/$OUT/checks"
echo "formal ($BUILD): $pass passed, $fail failed, $other error or unknown, of ${#SELECTED[@]} checks in ${secs} s" | tee -a "$ROOT/$OUT/summary.txt"
[ "$fail" -eq 0 ] && [ "$other" -eq 0 ]
