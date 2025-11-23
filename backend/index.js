const express = require("express");
const multer = require("multer");
const cors = require("cors");
const { MongoClient, GridFSBucket, ObjectId } = require("mongodb");
const stream = require("stream");
const fs = require("fs");
const path = require("path");
const bcrypt = require("bcryptjs");

const app = express();
const PORT = process.env.PORT || 5000;
const UPLOADS_DIR = path.join(__dirname, "uploads");

app.use(cors({
  origin: true,
  credentials: true
}));
app.use(express.json());

const mongoURI = "YOUR_MONGODB_URI_HERE";
const dbName = "YOUR_DB_NAME_HERE";

let gfsBucket;
let db;
let usersCollection;

const storage = multer.memoryStorage();
const upload = multer({ storage });

app.post("/api/upload", upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });
  try {
    const dbFiles = await gfsBucket.find({}).toArray();
    const usedSpace = dbFiles.reduce((sum, f) => sum + (f.length || 0), 0);
    if (usedSpace + req.file.size > 1024 * 1024 * 1024) {
      return res.status(400).json({ error: "Storage limit exceeded. Max 1GB allowed." });
    }
    const now = new Date();
    const recentFile = dbFiles.find(f =>
      f.filename === req.file.originalname &&
      f.length === req.file.size &&
      f.uploadDate &&
      (now - new Date(f.uploadDate)) < 60 * 1000
    );
    if (recentFile) {
      return res.status(409).json({ error: "Duplicate upload detected. File already uploaded recently." });
    }
    let base = req.file.originalname;
    let ext = "";
    if (base.lastIndexOf(".") !== -1) {
      ext = base.slice(base.lastIndexOf("."));
      base = base.slice(0, base.lastIndexOf("."));
    }
    let finalName = req.file.originalname;
    let count = 1;
    const allNames = dbFiles.map(f => f.filename);
    while (allNames.includes(finalName)) {
      count++;
      finalName = `${base} (${count})${ext}`;
    }
    const fileStream = new stream.PassThrough();
    fileStream.end(req.file.buffer);
    const uploadStream = gfsBucket.openUploadStream(finalName);
    const fileId = uploadStream.id;
    fileStream.pipe(uploadStream)
      .on("error", (err) => {
        console.error(err);
        res.status(500).json({ error: "Error uploading file" });
      })
      .on("finish", () => {
        res.json({
          message: "File uploaded successfully",
          id: fileId,
          filename: finalName
        });
      });
  } catch (err) {
    res.status(500).json({ error: "Error uploading file" });
  }
});

app.get("/api/files", async (req, res) => {
  try {
    const dbFiles = await gfsBucket.find({}).sort({ uploadDate: -1 }).toArray();
    const allFiles = dbFiles.map(f => ({
      id: f._id?.toString?.() || f._id,
      filename: f.filename,
      length: f.length || 0,
      source: "mongo",
      uploadDate: f.uploadDate || new Date(),
    }));
    res.json(allFiles);
  } catch (err) {
    res.status(500).json({ error: "Failed to list files" });
  }
});

app.get("/api/download/:id", (req, res) => {
  const fileId = req.params.id;
  try {
    gfsBucket.find({ _id: new ObjectId(fileId) }).toArray().then(files => {
      if (files.length) {
        res.setHeader('Content-Disposition', `attachment; filename="${files[0].filename}"`);
        gfsBucket.openDownloadStream(new ObjectId(fileId))
          .on("error", () => res.status(404).json({ error: "File not found" }))
          .pipe(res);
      } else {
        res.status(404).json({ error: "File not found" });
      }
    });
  } catch {
    res.status(404).json({ error: "File not found" });
  }
});

app.delete("/api/delete/:id", async (req, res) => {
  const fileId = req.params.id;
  try {
    const files = await gfsBucket.find({ _id: new ObjectId(fileId) }).toArray();
    if (files.length) {
      const chunks = [];
      const downloadStream = gfsBucket.openDownloadStream(new ObjectId(fileId));
      downloadStream.on('data', chunk => chunks.push(chunk));
      downloadStream.on('end', async () => {
        const buffer = Buffer.concat(chunks);
        if (!global.trashCollection) {
          global.trashCollection = db.collection("trash");
        }
        await global.trashCollection.insertOne({
          fileId: files[0]._id,
          filename: files[0].filename,
          length: files[0].length,
          uploadDate: files[0].uploadDate,
          deletedAt: new Date(),
          buffer: buffer,
        });
        await gfsBucket.delete(new ObjectId(fileId));
        return res.json({ message: "Moved to trash" });
      });
      downloadStream.on('error', err => {
        res.status(500).json({ error: "Error reading file for trash: " + err.message });
      });
    } else {
      res.status(404).json({ error: "File not found" });
    }
  } catch (err) {
    res.status(500).json({ error: "Delete failed" });
  }
});

const USERS = [
  { username: "USER1", password: "PASS" },
  { username: "USER2", password: "PASS" },
  { username: "USER3", password: "PASS" }
];

app.post("/api/login", (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) return res.status(400).json({ error: "Missing credentials" });
  const user = USERS.find(u => u.username === username && u.password === password);
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  res.json({ success: true, username });
});

app.get("/api/trash", async (req, res) => {
  try {
    if (!global.trashCollection) {
      global.trashCollection = db.collection("trash");
    }
    const trashFiles = await global.trashCollection.find({}).sort({ deletedAt: -1 }).toArray();
    res.json(trashFiles);
  } catch (err) {
    res.status(500).json({ error: "Failed to list trash" });
  }
});

app.delete("/api/trash/delete/:id", async (req, res) => {
  const trashId = req.params.id;
  try {
    if (!global.trashCollection) {
      global.trashCollection = db.collection("trash");
    }
    await global.trashCollection.deleteOne({ fileId: new ObjectId(trashId) });
    res.json({ message: "Deleted permanently" });
  } catch (err) {
    res.status(500).json({ error: "Permanent delete failed" });
  }
});

app.delete("/api/trash/clear", async (req, res) => {
  try {
    if (!global.trashCollection) {
      global.trashCollection = db.collection("trash");
    }
    await global.trashCollection.deleteMany({});
    res.json({ message: "Trash cleared" });
  } catch (err) {
    res.status(500).json({ error: "Clear trash failed" });
  }
});

app.post("/api/trash/restore/:id", async (req, res) => {
  const trashId = req.params.id;
  try {
    if (!global.trashCollection) {
      global.trashCollection = db.collection("trash");
    }
    const trashFile = await global.trashCollection.findOne({ fileId: new ObjectId(trashId) });
    if (!trashFile) return res.status(404).json({ error: "Trash file not found" });
    if (trashFile.buffer) {
      const fileStream = new stream.PassThrough();
      fileStream.end(Buffer.from(trashFile.buffer.buffer));
      const uploadStream = gfsBucket.openUploadStream(trashFile.filename);
      fileStream.pipe(uploadStream)
        .on("error", async (err) => {
          await global.trashCollection.deleteOne({ fileId: new ObjectId(trashId) });
          res.status(500).json({ error: "Restore failed: " + err.message });
        })
        .on("finish", async () => {
          await global.trashCollection.deleteOne({ fileId: new ObjectId(trashId) });
          res.json({ message: "Restored" });
        });
    } else {
      await global.trashCollection.deleteOne({ fileId: new ObjectId(trashId) });
      res.json({ message: "Restored (metadata only)" });
    }
  } catch (err) {
    res.status(500).json({ error: "Restore failed" });
  }
});

app.get("/api/user", async (req, res) => {
  const { username } = req.query;
  if (!username) return res.status(400).json({ error: "Missing username" });
  const user = USERS.find(u => u.username === username);
  if (!user) return res.status(404).json({ error: "User not found" });
  res.json({ username: user.username, password: user.password });
});

app.post("/api/change-password", (req, res) => {
  const { username, oldPassword, newPassword } = req.body;
  if (!username || !oldPassword || !newPassword) return res.status(400).json({ error: "Missing fields" });
  const user = USERS.find(u => u.username === username && u.password === oldPassword);
  if (!user) return res.status(401).json({ error: "Invalid username or password" });
  user.password = newPassword;
  res.json({ success: true });
});

MongoClient.connect(mongoURI)
  .then(client => {
    db = client.db(dbName);
    gfsBucket = new GridFSBucket(db, { bucketName: "uploads" });
    console.log("✅ MongoDB connected");
    app.listen(PORT, () => console.log(`🚀 Server running at http://localhost:${PORT}`));
  })
  .catch(err => console.error("❌ MongoDB Connection Error:", err));