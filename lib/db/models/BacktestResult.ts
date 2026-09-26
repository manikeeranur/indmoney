import mongoose from "mongoose";

const BacktestResultSchema = new mongoose.Schema({
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

BacktestResultSchema.index({ date: 1, expiry: 1 }, { unique: true });

export default mongoose.models.BacktestResult || mongoose.model("BacktestResult", BacktestResultSchema);
