# asic/flow/constraints.tcl: the timing constraints and resizer limits, shared by pnr.tcl and measure.tcl
# (needs $flow and the CLOCK_NS environment variable)
create_clock -name clk -period $::env(CLOCK_NS) [get_ports clk]
set_clock_uncertainty 0.25 [get_clocks clk]
# the memory side of the pins is registered outside the block: give it 20% of the cycle on each side
set io_delay [expr {0.2 * $::env(CLOCK_NS)}]
set_input_delay $io_delay -clock clk [delete_from_list [all_inputs] [get_ports clk]]
set_output_delay $io_delay -clock clk [all_outputs]
set_driving_cell -lib_cell sky130_fd_sc_hd__buf_4 -pin X [delete_from_list [all_inputs] [get_ports clk]]
set_load 0.02 [all_outputs]
source $flow/setRC.tcl
set_dont_use {sky130_fd_sc_hd__probe_* sky130_fd_sc_hd__lpflow_* sky130_fd_sc_hd__clkdlybuf4s* sky130_fd_sc_hd__a2111oi_0}
# the delay cells are buffers to the resizer: without this it strings them along long wires as "repeaters"
set_dont_use {sky130_fd_sc_hd__dlygate* sky130_fd_sc_hd__dlymetal*}
