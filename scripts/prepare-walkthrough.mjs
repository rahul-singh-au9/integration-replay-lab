import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const output = fileURLToPath(new URL('../.artifacts/walkthrough/', import.meta.url));
const manifest = JSON.parse(await readFile(`${output}/chapters.json`, 'utf8'));
const ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg';
const escapeHtml = (value) =>
  String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
const assTime = (seconds) => {
  const centiseconds = Math.round(seconds * 100);
  return `${Math.floor(centiseconds / 360000)}:${String(Math.floor(centiseconds / 6000) % 60).padStart(2, '0')}:${String(Math.floor(centiseconds / 100) % 60).padStart(2, '0')}.${String(centiseconds % 100).padStart(2, '0')}`;
};
const labelTime = (seconds) =>
  `${Math.floor(seconds / 60)}:${String(Math.floor(seconds) % 60).padStart(2, '0')}`;

for (const video of manifest.recordings) {
  if (!video.completed) throw new Error(`Incomplete recording: ${video.name}`);
  const mobile = video.viewport.width < 600;
  const height = video.viewport.height + 100;
  const captions =
    `[Script Info]\nScriptType: v4.00+\nPlayResX: ${video.viewport.width}\nPlayResY: ${height}\nWrapStyle: 0\n\n[V4+ Styles]\nFormat: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding\nStyle: Default,Arial,${mobile ? 17 : 24},&H00FFFFFF,&H00FFFFFF,&H00111827,&H00111827,0,0,0,0,100,100,0,0,1,0,0,2,20,20,22,1\n\n[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\n` +
    video.chapters
      .map((chapter, index) => {
        const end = video.chapters[index + 1]?.seconds ?? video.durationSeconds;
        const title = chapter.title.replaceAll('{', '').replaceAll('}', '');
        const text = chapter.note ? `${title}\\N${chapter.note}` : title;
        return `Dialogue: 0,${assTime(chapter.seconds)},${assTime(end)},Default,,0,0,0,,${text}`;
      })
      .join('\n');
  await writeFile(`${output}/${video.name}.ass`, captions);
  execFileSync(
    ffmpeg,
    [
      '-hide_banner',
      '-loglevel',
      'warning',
      '-y',
      '-i',
      video.filename,
      '-vf',
      `pad=iw:ih+100:0:0:color=0x111827,ass=${video.name}.ass`,
      '-c:v',
      'libx264',
      '-preset',
      'medium',
      '-crf',
      '20',
      '-pix_fmt',
      'yuv420p',
      '-movflags',
      '+faststart',
      '-an',
      `${video.name}.mp4`,
    ],
    { cwd: output, stdio: 'inherit', timeout: 120000 },
  );
  execFileSync(
    ffmpeg,
    ['-hide_banner', '-loglevel', 'error', '-i', `${video.name}.mp4`, '-f', 'null', '-'],
    { cwd: output, stdio: 'inherit', timeout: 60000 },
  );
  console.log(`Prepared and decoded ${video.name}.mp4`);
}

const panels = manifest.recordings
  .map(
    (video, index) =>
      `<section><h2>${index === 0 ? 'Complete desktop walkthrough' : 'Mobile walkthrough'}</h2><video id="video-${index}" controls preload="metadata" playsinline><source src="${video.name}.mp4" type="video/mp4"></video><p><a href="${video.name}.mp4" download>Download MP4</a> · <a href="${video.filename}" download>Original browser recording</a></p><ol>${video.chapters.map((chapter) => `<li><button data-video="video-${index}" data-seconds="${chapter.seconds}"><span>${labelTime(chapter.seconds)}</span>${escapeHtml(chapter.title)}</button>${chapter.note ? `<p>${escapeHtml(chapter.note)}</p>` : ''}</li>`).join('')}</ol></section>`,
  )
  .join('');
await writeFile(
  `${output}/index.html`,
  `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Integration Replay Lab — local walkthrough</title><style>body{font:16px/1.6 system-ui,sans-serif;background:#f5f7fc;color:#243b60;max-width:1100px;margin:40px auto;padding:0 24px}h1{font-size:32px;line-height:1.2}h2{font-size:23px}section{background:white;padding:24px;border:1px solid #d8e0ef;border-radius:16px;margin:24px 0}video{display:block;width:100%;max-height:740px;background:#111827;border-radius:8px}button{font:inherit;text-align:left;color:#375da8;background:none;border:0;padding:5px;cursor:pointer}button:hover{text-decoration:underline}button:focus-visible{outline:2px solid #375da8}button span{font-variant-numeric:tabular-nums;display:inline-block;min-width:55px}a{color:#375da8}li p{color:#536b8d;margin:0 0 8px 60px}ol{list-style:none;padding:0}small{color:#536b8d}</style><h1>Integration Replay Lab</h1><p>Actual local browser recordings, captured on ${escapeHtml(manifest.recordedAt.slice(0, 10))}. Save, reload, open and delete use the real local Worker API and D1 database. All examples are synthetic.</p><p>The storage-failure segment deliberately injects HTTP 503 responses. Captions occupy an added strip below the original browser viewport. The workflows are continuous, without sped-up or reconstructed interactions; there is no audio track.</p>${panels}<small>Local verification only. These recordings do not show a public deployment or live webhook delivery.</small><script>document.querySelectorAll('button[data-video]').forEach(button=>button.addEventListener('click',()=>{const video=document.getElementById(button.dataset.video);video.currentTime=Number(button.dataset.seconds);video.play().catch(()=>{});video.scrollIntoView({behavior:'smooth',block:'center'});}));</script></html>`,
);
console.log(`Chapter player: ${output}/index.html`);
