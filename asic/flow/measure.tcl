# =============================================================================
# asic/flow/measure.tcl: measure a saved database again, with placement parasitics (no routing needed)
#
#   CLOCK_NS=30 PDK_DIR=<sky130_fd_sc_hd dir> FLOW_DIR=$PWD/asic/flow ODB=build/asic/planned/before_route.odb \
#     OUT=<file.json> PLACEMENT=planned openroad -no_init -exit asic/flow/measure.tcl
#
# Writes the same JSON as pnr.tcl's metrics_placed.json, so a run whose routing is still going (or was stopped)
# can be compared from its before_route.odb.
# =============================================================================
set placement $::env(PLACEMENT)
set pdk $::env(PDK_DIR)
set flow $::env(FLOW_DIR)
set macro_dir [expr {[info exists ::env(MACRO_DIR)] ? $::env(MACRO_DIR) : [file normalize $flow/../macros/sram22_64x32m4w8]}]
read_lef $pdk/techlef/sky130_fd_sc_hd__nom.tlef
read_lef $pdk/lef/sky130_fd_sc_hd.lef
read_lef $macro_dir/sram22_64x32m4w8.lef
read_liberty $pdk/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
read_liberty $macro_dir/sram22_64x32m4w8_tt_025C_1v80.lib
read_db $::env(ODB)
source $flow/constraints.tcl
set_propagated_clock [all_clocks]
estimate_parasitics -placement
source $flow/metrics.tcl
measure placed $::env(OUT)
