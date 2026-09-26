import mongoose from "mongoose";

const Vwap930BacktestResultSchema = new mongoose.Schema({
  date:         { type: String, required: true },
  expiry:       { type: String, required: true },
  runAt:        { type: Date, default: Date.now },
  totalSignals: Number,
  wins:         Number,
  losses:       Number,
  eod:          Number,
  winRate:      Number,
  results:      [mongoose.Schema.Types.Mixed],
}, { timestamps: false });

Vwap930BacktestResultSchema.index({ date: 1, expiry: 1 }, { unique: true });

export default mongoose.models.Vwap930BacktestResult || mongoose.model("Vwap930BacktestResult", Vwap930BacktestResultSchema);
