const daysAgo = (days) => new Date(Date.now() - days * 86_400_000).toISOString();

function userIdByRole(users, role) {
  return users.find((user) => user.role === role)?.id || null;
}

export function buildCuratedDemoData(users = []) {
  const adminId = userIdByRole(users, "Admin");
  const salesId = userIdByRole(users, "Sales");
  const technicianId = userIdByRole(users, "Technician");
  const supervisorId = userIdByRole(users, "Supervisor");

  const clients = [
    { id: "c_zimplats", name: "Zimplats", client_type: "permanent", contact_person: "Procurement Office", email: "procurement@zimplats.example", is_active: true },
    { id: "c_mimosa", name: "Mimosa Mining Company", client_type: "permanent", contact_person: "Maintenance Office", email: "maintenance@mimosa.example", is_active: true },
    { id: "c_unki", name: "Unki Platinum Mine", client_type: "permanent", contact_person: "Plant Maintenance", email: "maintenance@unki.example", is_active: true }
  ];

  const mine_sites = [
    { id: "ms_ngezi", client_id: "c_zimplats", name: "Ngezi", location: "Zimbabwe", is_active: true },
    { id: "ms_selous", client_id: "c_zimplats", name: "Selous", location: "Zimbabwe", is_active: true },
    { id: "ms_zvishavane", client_id: "c_mimosa", name: "Zvishavane", location: "Zimbabwe", is_active: true },
    { id: "ms_unki", client_id: "c_unki", name: "Unki Mine", location: "Shurugwi", is_active: true }
  ];

  const plants = [
    { id: "pl_smc", mine_site_id: "ms_ngezi", name: "SMC Concentrator", plant_code: "SMC-CON", is_active: true },
    { id: "pl_smelter", mine_site_id: "ms_selous", name: "Smelter", plant_code: "SMELTER", is_active: true },
    { id: "pl_mimosa_conc", mine_site_id: "ms_zvishavane", name: "Concentrator", plant_code: "MIM-CON", is_active: true },
    { id: "pl_unki_conc", mine_site_id: "ms_unki", name: "Unki Concentrator", plant_code: "UNKI-CON", is_active: true }
  ];

  const plant_sections = [
    { id: "ps_cyclone", plant_id: "pl_smc", name: "Cyclone Cluster", section_code: "CYCLONE", is_active: true },
    { id: "ps_conveyor", plant_id: "pl_smc", name: "Discharge Conveyor", section_code: "CONV-DIS", is_active: true },
    { id: "ps_furnace", plant_id: "pl_smelter", name: "Furnace Refractory", section_code: "FURN-REF", is_active: true },
    { id: "ps_ball_mill", plant_id: "pl_unki_conc", name: "Ball Mill", section_code: "BALL-MILL", is_active: true }
  ];

  const equipment_tags = [
    { id: "eq_smc_0102", plant_section_id: "ps_cyclone", tag_code: "EQ-TAG-SMC-0102", equipment_name: "Cyclone Wear Liner Assembly", criticality: "high", status: "active", is_active: true },
    { id: "eq_smc_0207", plant_section_id: "ps_conveyor", tag_code: "EQ-TAG-SMC-0207", equipment_name: "Discharge Conveyor Idler Bank", criticality: "medium", status: "active", is_active: true },
    { id: "eq_smelt_0041", plant_section_id: "ps_furnace", tag_code: "EQ-TAG-SMELT-0041", equipment_name: "Furnace Lining Zone", criticality: "critical", status: "active", is_active: true },
    { id: "eq_unki_0301", plant_section_id: "ps_ball_mill", tag_code: "EQ-TAG-UNKI-0301", equipment_name: "Ball Mill Liner Set", criticality: "high", status: "active", is_active: true }
  ];

  const catalog_items = [
    { id: "cat_ceramic", item_code: "ALU-CER-TILE", item_name: "Alumina Ceramic Tiles", category: "Wear Protection", unit_of_measure: "m2", unit_price: 95, is_active: true },
    { id: "cat_rubber", item_code: "RUB-LINING", item_name: "Heavy Duty Rubber Lining", category: "Lining", unit_of_measure: "m2", unit_price: 70, is_active: true },
    { id: "cat_idler", item_code: "IDLER-ROLLER", item_name: "Idler Roller", category: "Conveyor Components", unit_of_measure: "each", unit_price: 120, is_active: true },
    { id: "cat_labor", item_code: "LAB-FIELD-HR", item_name: "Field Service Labour", category: "Labour", unit_of_measure: "hour", unit_price: 45, is_active: true }
  ];

  const quotes = [
    { id: "q_demo_001", quotation_number: "Q-2026-001", client_id: "c_zimplats", equipment_tag_id: "eq_smc_0102", status: "Draft", total_amount: 12_500, created_by: salesId, created_at: daysAgo(21) },
    { id: "q_demo_002", quotation_number: "Q-2026-002", client_id: "c_mimosa", equipment_tag_id: "eq_smelt_0041", status: "Sent", total_amount: 34_200, created_by: salesId, created_at: daysAgo(16) },
    { id: "q_demo_003", quotation_number: "Q-2026-003", client_id: "c_zimplats", equipment_tag_id: "eq_smc_0207", status: "Approved_Pending_PO", total_amount: 22_000, created_by: salesId, created_at: daysAgo(12) },
    { id: "q_demo_004", quotation_number: "Q-2026-004", client_id: "c_zimplats", equipment_tag_id: "eq_smc_0102", status: "PO_Verified", total_amount: 45_000, created_by: salesId, created_at: daysAgo(28) },
    { id: "q_demo_005", quotation_number: "Q-2026-005", client_id: "c_mimosa", equipment_tag_id: "eq_smelt_0041", status: "PO_Verified", total_amount: 29_800, created_by: salesId, created_at: daysAgo(36) },
    { id: "q_demo_006", quotation_number: "Q-2026-006", client_id: "c_zimplats", equipment_tag_id: "eq_smc_0207", status: "Invoiced", total_amount: 37_200, created_by: salesId, created_at: daysAgo(50) }
  ];

  const purchase_orders = [
    { id: "po_demo_004", quotation_id: "q_demo_004", po_reference: "ZIM-PO-2026-4401", po_amount: 45_000, status: "verified", logged_value: 31_500, requires_amendment: false, started_before_po: false, created_at: daysAgo(25) },
    { id: "po_demo_005", quotation_id: "q_demo_005", po_reference: "MIM-PO-2026-1288", po_amount: 29_800, status: "verified", logged_value: 32_500, requires_amendment: true, started_before_po: false, created_at: daysAgo(33) },
    { id: "po_demo_006", quotation_id: "q_demo_006", po_reference: "ZIM-PO-2026-4302", po_amount: 37_200, status: "verified", logged_value: 36_900, requires_amendment: false, started_before_po: false, created_at: daysAgo(47) }
  ];

  const dispatch_cards = [
    { id: "dc_demo_004", dispatch_number: "DC-2026-004", quotation_id: "q_demo_004", purchase_order_id: "po_demo_004", equipment_tag_id: "eq_smc_0102", status: "In_Progress", assigned_technician_id: technicianId, scheduled_start: daysAgo(5), started_before_po: false },
    { id: "dc_demo_005", dispatch_number: "DC-2026-005", quotation_id: "q_demo_005", purchase_order_id: "po_demo_005", equipment_tag_id: "eq_smelt_0041", status: "In_Progress", assigned_technician_id: technicianId, scheduled_start: daysAgo(8), started_before_po: false },
    { id: "dc_demo_006", dispatch_number: "DC-2026-006", quotation_id: "q_demo_006", purchase_order_id: "po_demo_006", equipment_tag_id: "eq_smc_0207", status: "Completed", assigned_technician_id: technicianId, scheduled_start: daysAgo(42), started_before_po: false }
  ];

  const field_worksheets = [
    { id: "fw_demo_001", dispatch_card_id: "dc_demo_004", technician_id: technicianId, supervisor_id: supervisorId, work_date: daysAgo(4), hours: 8, activity: "Prepared cyclone surfaces for ceramic relining", outcomes: "Surface preparation complete", status: "Supervisor_Approved" },
    { id: "fw_demo_002", dispatch_card_id: "dc_demo_004", technician_id: technicianId, supervisor_id: supervisorId, work_date: daysAgo(2), hours: 9, activity: "Installed ceramic tiles on cyclone sections one to three", outcomes: "Three sections completed", status: "Submitted" },
    { id: "fw_demo_003", dispatch_card_id: "dc_demo_005", technician_id: technicianId, supervisor_id: supervisorId, work_date: daysAgo(6), hours: 7, activity: "Replaced furnace wear protection panels", outcomes: "Torque values require correction", status: "Returned_For_Correction" },
    { id: "fw_demo_004", dispatch_card_id: "dc_demo_006", technician_id: technicianId, supervisor_id: supervisorId, work_date: daysAgo(40), hours: 10, activity: "Completed conveyor idler replacement", outcomes: "Conveyor returned to service", status: "Supervisor_Approved" }
  ];

  const suppliers = [
    { id: "sup_ceramics", name: "African Ceramics Supply Co.", contact_person: "Demo Procurement", email: "procurement@ceramics.example", phone: "+263 242 000 001", lead_time_days: 14 },
    { id: "sup_rubber", name: "Zimrubber Industrial", contact_person: "Demo Procurement", email: "procurement@rubber.example", phone: "+263 242 000 002", lead_time_days: 7 },
    { id: "sup_conveyor", name: "ConveyorTech Africa", contact_person: "Demo Procurement", email: "procurement@conveyor.example", phone: "+263 242 000 003", lead_time_days: 21 }
  ];

  const stock_items = [
    { id: "si_ceramic", catalog_item_id: "cat_ceramic", item_code: "ALU-CER-TILE", item_name: "Alumina Ceramic Tiles", unit_of_measure: "m2", quantity_on_hand: 18, reorder_level: 20, unit_cost: 85, supplier_id: "sup_ceramics", location: "Store A - Shelf 1" },
    { id: "si_rubber", catalog_item_id: "cat_rubber", item_code: "RUB-LINING", item_name: "Heavy Duty Rubber Lining", unit_of_measure: "m2", quantity_on_hand: 30, reorder_level: 15, unit_cost: 60, supplier_id: "sup_rubber", location: "Store A - Shelf 2" },
    { id: "si_idler", catalog_item_id: "cat_idler", item_code: "IDLER-ROLLER", item_name: "Idler Roller", unit_of_measure: "each", quantity_on_hand: 12, reorder_level: 8, unit_cost: 100, supplier_id: "sup_conveyor", location: "Store B - Rack 3" },
    { id: "si_fastener", catalog_item_id: null, item_code: "FAST-M16-SS", item_name: "M16 Stainless Fastener Kit", unit_of_measure: "set", quantity_on_hand: 60, reorder_level: 25, unit_cost: 12, supplier_id: "sup_ceramics", location: "Store A - Shelf 4" }
  ];

  return {
    clients,
    mine_sites,
    plants,
    plant_sections,
    equipment_tags,
    catalog_items,
    leads: [
      { id: "lead_demo_001", company_name: "Demo Mining Services", contact_name: "Demo Contact", email: "contact@demo-mining.example", phone: "+263 242 000 010", mine_site: "Ngezi", service_need: "Conveyor inspection", urgency: "standard", status: "New", created_at: daysAgo(1) }
    ],
    quotes,
    quote_lines: [
      { id: "ql_demo_004", quotation_id: "q_demo_004", catalog_item_id: "cat_ceramic", description: "Cyclone ceramic lining", quantity: 48, unit_price: 95, line_total: 4_560 },
      { id: "ql_demo_005", quotation_id: "q_demo_005", catalog_item_id: "cat_rubber", description: "Furnace protection panels", quantity: 120, unit_price: 70, line_total: 8_400 },
      { id: "ql_demo_006", quotation_id: "q_demo_006", catalog_item_id: "cat_idler", description: "Idler roller replacement", quantity: 24, unit_price: 120, line_total: 2_880 }
    ],
    purchase_orders,
    po_amendments: [],
    dispatch_cards,
    field_worksheets,
    timesheets: [
      { id: "ts_demo_004", dispatch_card_id: "dc_demo_004", technician_id: technicianId, hours_logged: 17, hourly_rate: 45, created_at: daysAgo(2) },
      { id: "ts_demo_005", dispatch_card_id: "dc_demo_005", technician_id: technicianId, hours_logged: 7, hourly_rate: 45, created_at: daysAgo(6) },
      { id: "ts_demo_006", dispatch_card_id: "dc_demo_006", technician_id: technicianId, hours_logged: 10, hourly_rate: 45, created_at: daysAgo(40) }
    ],
    material_usage: [
      { id: "mu_demo_004", dispatch_card_id: "dc_demo_004", stock_item_id: "si_ceramic", description: "Ceramic tiles", quantity: 30, unit_cost: 85, total_cost: 2_550 },
      { id: "mu_demo_005", dispatch_card_id: "dc_demo_005", stock_item_id: "si_rubber", description: "Rubber panels", quantity: 20, unit_cost: 60, total_cost: 1_200 }
    ],
    invoices: [{ id: "inv_demo_006", dispatch_card_id: "dc_demo_006", invoice_number: "INV-2026-006", status: "Issued", total_amount: 37_200, created_at: daysAgo(35) }],
    invoice_lines: [{ id: "il_demo_006", invoice_id: "inv_demo_006", description: "Conveyor idler replacement", quantity: 1, unit_price: 37_200, line_total: 37_200 }],
    suppliers,
    stock_items,
    stock_movements: [{ id: "sm_demo_001", stock_item_id: "si_ceramic", movement_type: "out", quantity: -30, quantity_after: 18, reason: "Issued to DC-2026-004", reference_id: "dc_demo_004", created_at: daysAgo(5) }],
    audit_logs: [{ id: "audit_demo_seed", actor_id: adminId || "system", entity_type: "system", entity_id: "curated-demo", action: "CURATED_DEMO_DATA_APPLIED", old_values: null, new_values: { quote_count: quotes.length }, created_at: new Date().toISOString() }],
    notifications: [{ id: "notification_demo_001", user_id: supervisorId, type: "worksheet_submitted", message: "Worksheet FW-DEMO-002 is ready for supervisor review.", read_at: null, created_at: daysAgo(1) }],
    access_requests: [{ id: "access_demo_001", name: "Demo Technician", email: "technician@demo.example", requested_role: "Technician", reason: "Demonstration request", status: "Pending", created_at: daysAgo(2) }],
    pastel_export_batches: [],
    pastel_export_lines: [],
    company_profile: { company_name: "Orac Systems", legal_name: "Handon Enterprises (Pvt) Ltd", address: "Harare, Zimbabwe", phone: "+263 242 000 000", email: "info@orac.co.zw", brand_primary: "#6EC1E4", brand_slate: "#54595F" }
  };
}
