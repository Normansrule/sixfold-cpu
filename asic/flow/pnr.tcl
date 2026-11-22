# =============================================================================
# asic/flow/pnr.tcl: OpenROAD place and route of Sixfold_Silicon (run by asic/flow.sh, never alone)
#
# Environment: PLACEMENT (corner | planned | auto), CLOCK_NS, OUT, NETLIST, PDK_DIR
# Steps: floorplan -> pins -> SRAM macros -> tap cells and power grid -> global placement -> resize and buffer
# -> detailed placement -> clock tree -> timing repair -> global routing -> timing with routed-wire parasitics.
# Every number in metrics.json comes from OpenROAD's own reports in this run (typical corner, 25 C, 1.80 V).
# =============================================================================
set placement $::env(PLACEMENT)
set out $::env(OUT)
set pdk $::env(PDK_DIR)
set flow $::env(FLOW_DIR)
set macro_dir [expr {[info exists ::env(MACRO_DIR)] ? $::env(MACRO_DIR) : [file normalize $flow/../macros/sram22_64x32m4w8]}]

read_lef $pdk/techlef/sky130_fd_sc_hd__nom.tlef
read_lef $pdk/lef/sky130_fd_sc_hd.lef
read_lef $macro_dir/sram22_64x32m4w8.lef
read_liberty $pdk/lib/sky130_fd_sc_hd__tt_025C_1v80.lib
read_liberty $macro_dir/sram22_64x32m4w8_tt_025C_1v80.lib
read_verilog $::env(NETLIST)
link_design Sixfold_Silicon

# ---------------------------------------------------------------- constraints
source $flow/constraints.tcl

# ---------------------------------------------------------------- floorplan: the same die for every placement
set die_w 2760.0
set die_h 2040.0
set margin 20.0
initialize_floorplan -die_area "0 0 $die_w $die_h" -core_area "$margin $margin [expr {$die_w - $margin}] [expr {$die_h - $margin}]" -site unithd
make_tracks
set core [list [expr {$margin + 10}] [expr {$margin + 10}] [expr {$die_w - $margin - 10}] [expr {$die_h - $margin - 10}]]
set f [open $out/die.json w]; puts $f "{\"die\": \[0, 0, $die_w, $die_h\], \"core\": \[[join $core {, }]\]}"; close $f

# ---------------------------------------------------------------- pins: each cache's memory port on its own side
# instruction refill on the west edge, data refill and stores on the east edge, the rest on the south edge
proc port_names {patterns} {
  set names {}
  foreach p [get_ports $patterns] { lappend names [get_full_name $p] }
  return $names
}
set_io_pin_constraint -pin_names [port_names {INSTRUCTION_REFILL_*}] -region left:*
set_io_pin_constraint -pin_names [port_names {DATA_REFILL_* DATA_ADDRESS* DATA_WRITE_* DEVICE_READ_DATA*}] -region right:*
set_io_pin_constraint -pin_names [port_names {clk reset BRANCH_PREDICTION_ENABLE RESET_VECTOR* EXTERNAL_INTERRUPT_LINE TOHOST* HALTED}] -region bottom:*
place_pins -hor_layers met3 -ver_layers met2 -min_distance 2 -min_distance_in_tracks

# ---------------------------------------------------------------- SRAM macros
set block [ord::get_db_block]
set macros {}
foreach inst [$block getInsts] {
  if {[[$inst getMaster] getName] eq "sram22_64x32m4w8"} { lappend macros $inst }
}
set f [open $out/macros.txt w]
foreach inst $macros {
  set m [$inst getMaster]
  puts $f "[$inst getName] [ord::dbu_to_microns [$m getWidth]] [ord::dbu_to_microns [$m getHeight]]"
}
close $f
proc block_region {x0 y0 x1 y1} {
  set h 4
  odb::dbBlockage_create [ord::get_db_block] [ord::microns_to_dbu [expr {$x0 - $h}]] [ord::microns_to_dbu [expr {$y0 - $h}]] [ord::microns_to_dbu [expr {$x1 + $h}]] [ord::microns_to_dbu [expr {$y1 + $h}]]
}
proc place_sram {name x y orient} {
  set inst [[ord::get_db_block] findInst $name]
  $inst setOrient $orient
  $inst setLocation [ord::microns_to_dbu $x] [ord::microns_to_dbu $y]
  $inst setPlacementStatus FIRM
}
if {$placement eq "auto"} {
  # OpenROAD's automatic macro placer (TritonMacroPlacer): a first global placement of everything, macros included,
  # then the macros are snapped to legal spots that keep the wire length to the logic short. (This OpenROAD build's
  # hierarchical placer, rtl_macro_placer, needs a hierarchical netlist, and this flow synthesizes a flat one.)
  global_placement -density 0.45
  macro_placement -halo {12 12} -channel {24 24}
  foreach inst $macros { $inst setPlacementStatus FIRM }
} else {
  exec python3 $flow/macros.py $placement $out/macros.txt $out/die.json > $out/macros.tcl
  source $out/macros.tcl
}
# keep standard cells a little away from every macro (pin access and the power ring around it)
foreach inst $macros {
  set b [$inst getBBox]
  set h [ord::microns_to_dbu 4]
  odb::dbBlockage_create $block [expr {[$b xMin] - $h}] [expr {[$b yMin] - $h}] [expr {[$b xMax] + $h}] [expr {[$b yMax] + $h}]
}

# ---------------------------------------------------------------- tap cells and power grid
tapcell -distance 14 -tapcell_master sky130_fd_sc_hd__tapvpwrvgnd_1 -halo_width_x 4 -halo_width_y 4
add_global_connection -net VDD -pin_pattern {^VPWR$} -power
add_global_connection -net VDD -pin_pattern {^VPB$}
add_global_connection -net VDD -pin_pattern {^vdd$}
add_global_connection -net VSS -pin_pattern {^VGND$} -ground
add_global_connection -net VSS -pin_pattern {^VNB$}
add_global_connection -net VSS -pin_pattern {^vss$}
set_voltage_domain -name CORE -power VDD -ground VSS
define_pdn_grid -name grid -voltage_domains CORE -pins met5
add_pdn_stripe -grid grid -layer met1 -width 0.48 -pitch 5.44 -offset 0 -followpins
add_pdn_stripe -grid grid -layer met4 -width 1.6 -pitch 27.14 -offset 13.57
add_pdn_stripe -grid grid -layer met5 -width 1.6 -pitch 27.2 -offset 13.6
add_pdn_connect -grid grid -layers {met1 met4}
add_pdn_connect -grid grid -layers {met4 met5}
# the macros' supply rails are horizontal metal 2 bars: vertical metal 4 straps over each macro reach them
define_pdn_grid -name sram -voltage_domains CORE -macro -cells sram22_64x32m4w8 -halo {4 4 4 4} -grid_over_boundary
add_pdn_stripe -grid sram -layer met4 -width 1.6 -pitch 27.14 -offset 13.57
add_pdn_connect -grid sram -layers {met2 met4}
add_pdn_connect -grid sram -layers {met4 met5}
pdngen

# ---------------------------------------------------------------- place
global_placement -density 0.45 -routability_driven -pad_left 1 -pad_right 1
write_db $out/global_placement.odb
estimate_parasitics -placement
remove_buffers
repair_design -max_wire_length 800
detailed_placement -max_displacement {3000 3000}
optimize_mirroring
check_placement -verbose

# ---------------------------------------------------------------- clock tree
repair_clock_inverters
clock_tree_synthesis -root_buf sky130_fd_sc_hd__clkbuf_16 -buf_list {sky130_fd_sc_hd__clkbuf_4 sky130_fd_sc_hd__clkbuf_8} -sink_clustering_enable
set_propagated_clock [all_clocks]
estimate_parasitics -placement
repair_clock_nets
detailed_placement -max_displacement {3000 3000}
repair_timing -setup
repair_timing -hold -slack_margin 0.05
detailed_placement -max_displacement {3000 3000}
check_placement -verbose

# ---------------------------------------------------------------- global route, timing with routed parasitics
set_global_routing_layer_adjustment met1-met5 0.2
set_routing_layers -signal met1-met5 -clock met3-met5
write_db $out/before_route.odb
source $flow/metrics.tcl
estimate_parasitics -placement
measure placed $out/metrics_placed.json
write_def $out/Sixfold_Silicon.def
if {[info exists ::env(STOP_AFTER)] && $::env(STOP_AFTER) eq "place"} { exit }  ;# placement only (asic/flow.sh ... place)
global_route -guide_file $out/route.guide -allow_congestion -congestion_iterations 30 -verbose
estimate_parasitics -global_routing
# The routed wires are longer than placement guessed (detours around the macros and congested tiles): repair
# again with their real lengths, then route again from scratch (this OpenROAD build has no incremental global
# route), so the reports below see every wire as routed, the new repeaters' included.
repair_design -max_wire_length 800
repair_timing -setup
repair_timing -hold -slack_margin 0.05
detailed_placement -max_displacement {3000 3000}
check_placement -verbose
global_route -guide_file $out/route.guide -allow_congestion -congestion_iterations 30 -verbose
estimate_parasitics -global_routing

# ---------------------------------------------------------------- reports
measure routed $out/metrics.json
write_def $out/Sixfold_Silicon.def
write_db $out/Sixfold_Silicon.odb
