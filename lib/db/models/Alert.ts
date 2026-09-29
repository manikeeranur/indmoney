import mongoose from "mongoose";

const AlertSchema = new mongoose.Schema({
  alertId:       { type: String, required: true, unique: true },
  date:          { type: String, required: true },
  tradingsymbol: String,
  token:         Number,
  direction:     String,
  strike:        Number,
  expiry:        String,
  entryTime:  String,
  exitTime:   String,
  exitedAt:   String,
  spot:       Number,
  concepts:   [String],
  patternZones: mongoose.Schema.Types.Mixed,
  score:      Number,
  effScore:   Number,
  strength:   String,
  trendOk:    Boolean,
  rr:         mongoose.Schema.Types.Mixed,
  status:     String,
  currentPnL: Number,
  pnlPct:     Number,
  peakMove:   Number,
  t1Hit:      Boolean,
  t1HitTime:  String,
  lastLtp:    Number,
  createdAt:  String,
  updatedAt:  { type: Date, default: Date.now },
}, { timestamps: false });

// mongoose.models.X || mongoose.model(...) — required in dev: Next hot-reloads
// this module on every edit, and re-registering the same model name throws
// "OverwriteModelError" without the guard.
export default mongoose.models.Alert || mongoose.model("Alert", AlertSchema);
