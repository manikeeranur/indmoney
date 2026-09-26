import mongoose from "mongoose";

const AccountDefaultsSchema = new mongoose.Schema({
  lockPoints:  { type: Number, default: null },
  stopLoss:    { type: Number, default: null },
  target:      { type: Number, default: null },
  quantity:    { type: Number, default: 10, enum: [1, 2, 5, 10, 15, 20] },
  productType: { type: String, default: "MIS", enum: ["MIS", "NRML", "INTRADAY", "MARGIN"] },
  tradingMode: { type: String, default: "PAPER", enum: ["LIVE", "PAPER"] },
  breakevenTriggerPct: { type: Number, default: null },
}, { _id: false });

const GlobalLockSchema = new mongoose.Schema({
  on:  { type: Boolean, default: false },
  pts: { type: Number,  default: null },
}, { _id: false });

const SettingsSchema = new mongoose.Schema({
  key:                     { type: String, required: true, unique: true, default: "global" },
  smcAutoTradeEnabled:     { type: Boolean, default: false },
  vwap930AutoTradeEnabled: { type: Boolean, default: false },
  accountDefaults:         { type: AccountDefaultsSchema, default: () => ({}) },
  globalLock:              { type: GlobalLockSchema, default: () => ({}) },
  updatedAt:               { type: Date, default: Date.now },
});

export default mongoose.models.Settings || mongoose.model("Settings", SettingsSchema);
