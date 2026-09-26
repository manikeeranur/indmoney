import mongoose from "mongoose";

const Vwap930AlertSchema = new mongoose.Schema({
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
  vwap:       Number,
  vwapCE:     Number,
  vwapPE:     Number,
  rr:         mongoose.Schema.Types.Mixed,
  status:     String,
  currentPnL: Number,
  pnlPct:     Number,
  peakMove:   Number,
  lastLtp:    Number,
  createdAt:  String,
  updatedAt:  { type: Date, default: Date.now },
}, { timestamps: false });

export default mongoose.models.Vwap930Alert || mongoose.model("Vwap930Alert", Vwap930AlertSchema);
