import mongoose from "mongoose";

const PositionSchema = new mongoose.Schema({
  tradingsymbol: String,
  direction:     String,
  strike:        Number,
  quantity:      Number,
  buyPrice:      Number,
  sellPrice:     Number,
  pnl:           Number,
  status:        String,
  entryTime:     String,
  exitTime:      String,
}, { _id: false });

const DailyPnLSchema = new mongoose.Schema({
  date:    { type: String, required: true, unique: true },
  positions: [PositionSchema],
  charges: {
    brokerage: Number, stt: Number, exchange: Number,
    sebi: Number, gst: Number, stampDuty: Number, total: Number,
  },
  pnl:     { realised: Number, unrealised: Number, total: Number },
  savedAt: { type: Date, default: Date.now },
}, { timestamps: false });

export default mongoose.models.DailyPnL || mongoose.model("DailyPnL", DailyPnLSchema);
