export const TECHNICIAN_TRADES = [
  "Fitter",
  "Fitter Assistant",
  "Boilermaker",
  "Boilermaker Assistant",
  "Instrument Technician",
  "Instrument Assistant",
  "Scaffolder Assistant",
  "Rigger Assistant",
  "General Hand",
  "Plumber",
  "Plumber Assistant",
  "Welder Assistant",
  "Electrician"
];

export function isTechnicianTrade(value) {
  return value === null || value === undefined || TECHNICIAN_TRADES.includes(value);
}
