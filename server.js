const express = require('express');
const multer = require('multer');
const ffmpeg = require('fluent-ffmpeg');
const ffprobeStatic = require('ffprobe-static');
const path = require('path');
const fs = require('fs');

ffmpeg.setFfprobePath(ffprobeStatic.path);

const app = express();

// Configure storage strictly on disk to prevent RAM blowouts with 15GB files
const storage = multer.diskStorage({
    destination: (req, file, cb) => {
        const dir = path.join(__dirname, 'uploads');
        if (!fs.existsSync(dir)) fs.mkdirSync(dir);
        cb(null, dir);
    },
    filename: (req, file, cb) => {
        cb(null, `raw_source_${Date.now()}${path.extname(file.originalname)}`);
    }
});

// Remove any upload file size limits completely for local workflows
const upload = multer({ 
    storage: storage,
    limits: { fileSize: Infinity } 
});

app.use(express.json());
app.use((req, res, next) => {
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
    next();
});

app.post('/compress', upload.single('video'), (req, res) => {
    const file = req.file;
    const targetSizeMB = parseFloat(req.body.targetSizeMB || 1000);
    const resolution = req.body.resolution; 

    if (!file) {
        return res.status(400).send('No file localized.');
    }

    const inputPath = file.path;
    const outputPath = path.join(__dirname, 'uploads', `out_target_${Date.now()}.mp4`);

    console.log(`🎬 Processing massive input file: ${file.originalname} (${(file.size / (1024*1024*1024)).toFixed(2)} GB)`);

    // Analyze internal metadata structural length
    ffmpeg.ffprobe(inputPath, (err, metadata) => {
        if (err) {
            cleanup(inputPath);
            return res.status(500).send('Analysis failed.');
        }

        const duration = metadata.format.duration; 
        console.log(`⏱️ Video length parsed: ${Math.floor(duration / 60)} minutes.`);

        // Bitrate calculation logic: Size in bits / duration in seconds
        const totalTargetBits = targetSizeMB * 1024 * 1024 * 8;
        let idealBitrate = Math.floor(totalTargetBits / duration);
        
        // Reserve audio bandwidth
        const audioBitrate = 128000;
        let calculatedVideoBitrate = idealBitrate - audioBitrate;

        // Safeguard floor constraint to avoid corrupting video stream
        if (calculatedVideoBitrate < 64000) calculatedVideoBitrate = 64000;

        console.log(`⚙️ Target rendering video bitrate calculated: ${Math.floor(calculatedVideoBitrate / 1000)} kbps`);

        let command = ffmpeg(inputPath)
            .videoCodec('libx264')
            .audioCodec('aac')
            .audioBitrate(128)
            .videoBitrate(Math.floor(calculatedVideoBitrate / 1000))
            .outputOptions([
                '-preset superfast', // Shifts processing weights completely onto local CPU speed
                '-movflags faststart'
            ]);

        // Downscale filters applied natively if selected
        if (resolution && resolution !== 'no-change') {
            const [w, h] = resolution.split(':');
            command.videoFilters(`scale=${w}:${h}`);
            console.log(`📐 Scaling output canvas parameters to: 720p (${w}x${h})`);
        }

        command.output(outputPath)
            .on('start', (cmd) => {
                console.log("🚀 Compression engine running locally via hardware hooks...");
            })
            .on('end', () => {
                console.log("✨ Local process complete. Piping output payload straight to browser container...");
                res.download(outputPath, (err) => {
                    cleanup(inputPath, outputPath);
                });
            })
            .on('error', (err) => {
                console.error('❌ Encoding error encountered:', err.message);
                cleanup(inputPath, outputPath);
                res.status(500).send('Processing dropped.');
            })
            .run();
    });
});

function cleanup(inP, outP) {
    try { if (inP && fs.existsSync(inP)) fs.unlinkSync(inP); } catch(e){}
    try { if (outP && fs.existsSync(outP)) fs.unlinkSync(outP); } catch(e){}
}

app.listen(3000, () => console.log('🏎️  Heavy Compressor running locally on http://localhost:3000'));
