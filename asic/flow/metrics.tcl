# asic/flow/metrics.tcl: measure the open design and write <file> (JSON) plus report sections in the log.
#   measure <stage> <file>: stage names the parasitics in use (placed: from placement, routed: from global routing)
# this build's report commands print through the logger ('>' does not redirect them): asic/flow.sh cuts each
# section between its === markers out of openroad.log into <name>.rpt
proc section {name body} { puts "=== BEGIN $name"; uplevel 1 $body; puts "=== END $name" }
# the slowest path that starts at an SRAM output (dout) and the slowest that ends at an SRAM input
proc worst_from {pins} {
  set worst 1e9
  foreach path [find_timing_paths -from $pins -path_delay max -group_count 1] { set worst [expr {min($worst, [get_property $path slack])}] }
  return $worst
}
proc worst_to {pins} {
  set worst 1e9
  foreach path [find_timing_paths -to $pins -path_delay max -group_count 1] { set worst [expr {min($worst, [get_property $path slack])}] }
  return $worst
}
proc measure {stage file} {
  global placement
  set block [ord::get_db_block]
  section ${stage}_critical_path { report_checks -path_delay max -fields {slew cap input_pins nets fanout} -digits 3 }
  section ${stage}_hold_path { report_checks -path_delay min -digits 3 }
  set wns [sta::worst_slack -max]
  set tns [sta::total_negative_slack -max]
  set hold [sta::worst_slack -min]
  section ${stage}_area { report_design_area }
  section ${stage}_skew { report_clock_skew }
  section ${stage}_power { report_power }

  # wire length: routed (from the global route guides, as FastRoute counts it) and half-perimeter of every net
  set hpwl 0.0
  set macro_nets 0.0
  foreach net [$block getNets] {
    if {[$net getSigType] in {POWER GROUND}} continue
    set xs {}; set ys {}; set touches_macro 0
    foreach it [$net getITerms] {
      lassign [$it getAvgXY] ok x y
      if {!$ok} { set bb [[$it getInst] getBBox]; set x [expr {([$bb xMin] + [$bb xMax]) / 2}]; set y [expr {([$bb yMin] + [$bb yMax]) / 2}] }
      lappend xs $x; lappend ys $y
      if {[[[$it getInst] getMaster] getName] eq "sram22_64x32m4w8"} { set touches_macro 1 }
    }
    foreach bt [$net getBTerms] {
      set bb [$bt getBBox]
      lappend xs [expr {([$bb xMin] + [$bb xMax]) / 2}]; lappend ys [expr {([$bb yMin] + [$bb yMax]) / 2}]
    }
    if {[llength $xs] < 2} continue
    set l [ord::dbu_to_microns [expr {[tcl::mathfunc::max {*}$xs] - [tcl::mathfunc::min {*}$xs] + [tcl::mathfunc::max {*}$ys] - [tcl::mathfunc::min {*}$ys]}]]
    set hpwl [expr {$hpwl + $l}]
    if {$touches_macro} { set macro_nets [expr {$macro_nets + $l}] }
  }

  set srams [get_cells -filter "ref_name == sram22_64x32m4w8" *]
  set sram_out [worst_from $srams]
  set sram_in [worst_to [get_pins -of_objects $srams -filter "direction == input"]]
  section ${stage}_sram_output_path { report_checks -from $srams -path_delay max -digits 3 }
  section ${stage}_sram_input_path { report_checks -to [get_pins -of_objects $srams -filter "direction == input"] -path_delay max -digits 3 }

  set cell_area 0.0; set cells 0
  foreach inst [$block getInsts] {
    set m [$inst getMaster]
    if {[$m getType] eq "CORE"} { set cell_area [expr {$cell_area + [ord::dbu_to_microns [$m getWidth]] * [ord::dbu_to_microns [$m getHeight]]}]; incr cells }
  }
  set period $::env(CLOCK_NS)
  set f [open $file w]
  puts $f [format {{
   "placement": "%s",
   "parasitics": "%s",
   "clock_target_ns": %s,
   "worst_setup_slack_ns": %.3f,
   "total_negative_slack_ns": %.3f,
   "worst_hold_slack_ns": %.3f,
   "achievable_period_ns": %.3f,
   "worst_slack_from_sram_outputs_ns": %.3f,
   "worst_slack_into_sram_inputs_ns": %.3f,
   "half_perimeter_wire_length_um": %.0f,
   "half_perimeter_of_nets_touching_srams_um": %.0f,
   "standard_cells": %d,
   "standard_cell_area_um2": %.0f,
   "macros": %d
  }} $placement $stage $period $wns $tns $hold [expr {$period - $wns}] $sram_out $sram_in $hpwl $macro_nets $cells $cell_area [llength $srams]]
  close $f
}
