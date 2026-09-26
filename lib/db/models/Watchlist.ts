import mongoose from "mongoose";

const WatchlistSchema = new mongoose.Schema({
  groupId:   { type: String, required: true, unique: true },
  name:      { type: String, required: true },
  items:     { type: mongoose.Schema.Types.Mixed, default: [] },
  updatedAt: { type: Date, default: Date.now },
});

export default mongoose.models.Watchlist || mongoose.model("Watchlist", WatchlistSchema);
