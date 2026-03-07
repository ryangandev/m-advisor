import ffmpegStatic from "ffmpeg-static";

if (ffmpegStatic) {
  process.env.FFMPEG_PATH = ffmpegStatic;
  console.log("ffmpeg path set:", ffmpegStatic);
}
