#!/usr/bin/env python3
"""Create a short, silent walkthrough from real browser captures.

Requires Python 3, ffmpeg (libx264 and libass), ffprobe and DejaVu Sans.
No network access, external API or image generation is involved.

Preview the proposed captions without rendering:
  python3 scripts/make-demo-video.py --list-scenes

Render after the final browser captures have been confirmed:
  python3 scripts/make-demo-video.py --duration 96

Override the sequence with a JSON manifest when needed:
  {"scenes": [{"frame": "01_inicio.jpg", "caption": "Texto verificado."}]}
  python3 scripts/make-demo-video.py --manifest artifacts/video-scenes.json

Inputs are left untouched. Captures remain fully visible, without simulated
cursor motion or invented interactions. Captions are burned into the MP4 and
also exported as optional VTT/SRT tracks. Output is limited to 7,900,000 bytes.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import shutil
import subprocess
import tempfile
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WIDTH, HEIGHT, CAPTURE_HEIGHT = 1600, 1200, 1040
MAX_BYTES = 7_900_000
CAPTIONS = {
    "01_inicio": "Umbral convierte facturas en decisiones explicables. Demostración local con datos ficticios. No mueve dinero.",
    "02_procesamiento": "El motor comprueba cada factura contra reglas explícitas. Decide pagar de forma simulada, frenar o solicitar revisión humana.",
    "03_duplicado": "Una factura repetida del mismo beneficiario se frena. La decisión explica que ya existe una reserva simulada para ese cobro.",
    "04_revision_segura": "La revisión humana vuelve a comprobar las reservas. Aquí frena la factura: el presupuesto y el saldo son insuficientes, aunque una persona la revise.",
    "05_reglas": "La empresa define el umbral automático, el límite por factura, el presupuesto, el saldo simulado y los beneficiarios permitidos.",
    "06_aprobacion": "Otro caso obtiene aprobación humana con las reglas actuales y capacidad suficiente. El resultado es una reserva simulada, nunca una transferencia.",
    "07_pruebas": "El banco compara resultados esperados y obtenidos en 16 escenarios ficticios. Esta ejecución coincide en los 16 casos, sin modificar la bandeja.",
    "08_bitacora": "La bitácora conserva decisiones, revisiones y cambios de política. Cada resultado deja una explicación local que se consulta y exporta.",
}


def run(command: list[str], cwd: Path | None = None) -> subprocess.CompletedProcess:
    completed = subprocess.run(command, cwd=cwd, text=True, capture_output=True)
    if completed.returncode:
        raise RuntimeError(f"Falló {command[0]}:\n{completed.stderr[-6000:]}")
    return completed


def subtitle_time(seconds: float, kind: str) -> str:
    unit = 100 if kind == "ass" else 1000
    total = round(seconds * unit)
    hours, rest = divmod(total, 3600 * unit)
    minutes, rest = divmod(rest, 60 * unit)
    seconds, fraction = divmod(rest, unit)
    if kind == "ass":
        return f"{hours}:{minutes:02}:{seconds:02}.{fraction:02}"
    separator = "," if kind == "srt" else "."
    return f"{hours:02}:{minutes:02}:{seconds:02}{separator}{fraction:03}"


def scene_list(frames: Path, manifest: Path | None, duration: float) -> list[dict]:
    if manifest:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        raw = data["scenes"]
    else:
        raw = []
        for path in sorted(frames.iterdir()):
            if path.suffix.lower() not in {".jpg", ".jpeg", ".png", ".webp"}:
                continue
            caption = CAPTIONS.get(path.stem)
            if caption is None:
                raise ValueError(f"Falta un subtítulo revisado para {path.name}. Usa --manifest.")
            raw.append({"frame": path.name, "caption": caption})
    if not isinstance(raw, list) or not 3 <= len(raw) <= 16:
        raise ValueError("Se requieren entre 3 y 16 escenas revisadas.")
    scenes = []
    total_weight = sum(float(item.get("weight", 1)) for item in raw)
    if total_weight <= 0:
        raise ValueError("La duración relativa de las escenas debe ser positiva.")
    at = 0.0
    for item in raw:
        path = (frames / item["frame"]).resolve()
        if path.parent != frames.resolve() or not path.is_file():
            raise ValueError(f"La captura no existe dentro de la carpeta permitida: {item['frame']}")
        caption = item.get("caption", "")
        if not isinstance(caption, str) or not caption.strip() or len(caption) > 350:
            raise ValueError("Cada escena necesita un subtítulo de 1 a 350 caracteres.")
        weight = float(item.get("weight", 1))
        if not 0 < weight <= 100:
            raise ValueError("Peso de escena inválido.")
        length = duration * weight / total_weight
        scenes.append({"frame": path.name, "path": path, "caption": caption.strip(), "start": at, "end": at + length})
        at += length
    return scenes


def subtitle_files(scenes: list[dict], temporary: Path, output: Path) -> None:
    ass = [
        "[Script Info]", "ScriptType: v4.00+", f"PlayResX: {WIDTH}", f"PlayResY: {HEIGHT}",
        "WrapStyle: 2", "", "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        "Style: Default,DejaVu Sans,33,&H00FFFFFF,&H00FFFFFF,&H00173F35,&H00173F35,0,0,0,0,100,100,0,0,1,0,0,2,72,72,35,1",
        "", "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    srt, vtt = [], ["WEBVTT", ""]
    for index, scene in enumerate(scenes, 1):
        # Keep text in a separate solid band. Never cover a control or a result.
        lines = textwrap.wrap(scene["caption"], width=84, break_long_words=False)
        if len(lines) > 3:
            raise ValueError("El subtítulo supera tres líneas. Acorta el texto o divide la escena.")
        plain = "\n".join(lines)
        ass_text = r"\N".join(lines).replace("{", "(").replace("}", ")")
        ass.append(f"Dialogue: 0,{subtitle_time(scene['start'], 'ass')},{subtitle_time(scene['end'], 'ass')},Default,,0,0,0,,{ass_text}")
        srt += [str(index), f"{subtitle_time(scene['start'], 'srt')} --> {subtitle_time(scene['end'], 'srt')}", plain, ""]
        vtt += [str(index), f"{subtitle_time(scene['start'], 'vtt')} --> {subtitle_time(scene['end'], 'vtt')}", plain, ""]
    (temporary / "captions.ass").write_text("\n".join(ass) + "\n", encoding="utf-8")
    output.with_suffix(".es.srt").write_text("\n".join(srt), encoding="utf-8")
    output.with_suffix(".es.vtt").write_text("\n".join(vtt), encoding="utf-8")


def render(scenes: list[dict], duration: float, output: Path) -> dict:
    for binary in ("ffmpeg", "ffprobe"):
        if not shutil.which(binary):
            raise RuntimeError(f"Falta {binary} en PATH.")
    output.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="umbral-video-") as temporary_name:
        temporary = Path(temporary_name)
        concat = ["ffconcat version 1.0"]
        for index, scene in enumerate(scenes):
            filename = f"capture-{index:02}{scene['path'].suffix.lower()}"
            shutil.copyfile(scene["path"], temporary / filename)
            scene["render_name"] = filename
            concat += [f"file '{filename}'", f"duration {scene['end'] - scene['start']:.6f}"]
        concat += [f"file '{scenes[-1]['render_name']}'"]
        (temporary / "frames.ffconcat").write_text("\n".join(concat) + "\n", encoding="utf-8")
        subtitle_files(scenes, temporary, output)
        filters = (
            f"scale={WIDTH}:{CAPTURE_HEIGHT}:force_original_aspect_ratio=decrease,"
            f"pad={WIDTH}:{HEIGHT}:(ow-iw)/2:0:color=0xf5f5ef,"
            f"drawbox=x=0:y={CAPTURE_HEIGHT}:w=iw:h={HEIGHT-CAPTURE_HEIGHT}:color=0x173f35:t=fill,"
            "ass=captions.ass,fps=12"
        )
        base = ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-f", "concat", "-safe", "0", "-i", "frames.ffconcat", "-t", str(duration), "-vf", filters, "-an", "-c:v", "libx264", "-preset", "slow", "-pix_fmt", "yuv420p", "-movflags", "+faststart"]
        run(base + ["-crf", "25", str(output)], temporary)
        if output.stat().st_size >= MAX_BYTES:
            # A fixed bitrate fallback leaves headroom for the MP4 container.
            bitrate = max(160, int(7_200_000 * 8 / duration / 1000))
            rate = ["-b:v", f"{bitrate}k", "-passlogfile", "encode-pass"]
            run(base + rate + ["-pass", "1", "-f", "null", "/dev/null"], temporary)
            run(base + rate + ["-pass", "2", str(output)], temporary)
        if output.stat().st_size >= MAX_BYTES:
            raise RuntimeError(f"El video pesa {output.stat().st_size} bytes. No cumple el límite de publicación.")
    probe = json.loads(run(["ffprobe", "-v", "error", "-show_entries", "format=duration,size:stream=codec_type,width,height,codec_name", "-of", "json", str(output)]).stdout)
    if abs(float(probe["format"]["duration"]) - duration) > 0.5:
        raise RuntimeError("La duración final no coincide con el guion.")
    if any(stream["codec_type"] == "audio" for stream in probe["streams"]):
        raise RuntimeError("El video debe ser silencioso.")
    run(["ffmpeg", "-hide_banner", "-loglevel", "error", "-y", "-i", str(output), "-frames:v", "1", "-q:v", "2", str(output.with_name(output.stem + "-poster.jpg"))])
    report = {
        "file": output.name, "duration_seconds": float(probe["format"]["duration"]),
        "bytes": output.stat().st_size, "sha256": hashlib.sha256(output.read_bytes()).hexdigest(),
        "source": "Capturas reales del navegador. Datos ficticios. Sin pagos reales.",
        "scenes": [{**{key: value for key, value in scene.items() if key not in {"path", "render_name"}}, "capture_sha256": hashlib.sha256(scene["path"].read_bytes()).hexdigest()} for scene in scenes],
        "probe": probe,
    }
    output.with_suffix(".build.json").write_text(json.dumps(report, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    return report


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--frames", type=Path, default=ROOT / "artifacts/video-frames")
    parser.add_argument("--output", type=Path, default=ROOT / "video/umbral-demo.mp4")
    parser.add_argument("--manifest", type=Path)
    parser.add_argument("--duration", type=float, default=96)
    parser.add_argument("--list-scenes", action="store_true")
    args = parser.parse_args()
    if not 80 <= args.duration <= 110:
        parser.error("El video debe durar entre 80 y 110 segundos.")
    scenes = scene_list(args.frames.resolve(), args.manifest, args.duration)
    if args.list_scenes:
        print(json.dumps([{key: value for key, value in scene.items() if key != "path"} for scene in scenes], ensure_ascii=False, indent=2))
        return
    report = render(scenes, args.duration, args.output.resolve())
    print(json.dumps({key: report[key] for key in ("file", "duration_seconds", "bytes", "sha256")}, ensure_ascii=False, indent=2))


if __name__ == "__main__":
    main()
