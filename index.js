import express from "express";
import cors from "cors";

const app = express();
app.use(cors());
app.use(express.json());

app.get("/", (req, res) => {
  res.send("Moderation API running");
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log("API running on port", PORT);
});
