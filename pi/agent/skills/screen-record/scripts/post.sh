#!/usr/bin/env bash
# screen-record 后处理：把录好的 .mov 转成更实用的形态
#
# 用法：
#   bash post.sh gif    <输入.mov> [宽度] [帧率]    # 转 GIF（默认 960px / 15fps）
#   bash post.sh mp4    <输入.mov> [crf]            # 转 H.264 MP4（默认 crf 23，越小越清晰越大）
#   bash post.sh small  <输入.mov> [crf]            # 压缩（默认 crf 28，体积明显变小）
#   bash post.sh trim   <输入.mov> <起> <时长>      # 剪一段，时间写成 00:00:05 或 5
#   bash post.sh frame  <输入.mov> [秒]             # 抽一帧当封面 PNG（默认第 1 秒）
#   bash post.sh info   <输入.mov>                  # 看分辨率/时长/码率
#
# 产物与输入同目录，文件名加后缀（-gif / -h264 / -small / -trim / -frame）。

set -uo pipefail

die() { printf '错误：%s\n' "$*" >&2; exit 1; }
say() { printf '%s\n' "$*"; }

command -v ffmpeg >/dev/null 2>&1 || die "需要 ffmpeg：brew install ffmpeg"

cmd="${1:-}"; shift 2>/dev/null || true
in="${1:-}"
[ -z "$cmd" ] && die "用法见脚本头部注释（gif / mp4 / small / trim / frame / info）"
[ -z "$in" ] && die "缺输入文件"
[ -f "$in" ] || die "找不到文件：$in"

base="${in%.*}"
dir=$(dirname "$in")
stem=$(basename "$base")

case "$cmd" in
  info)
    ffprobe -v error -show_entries stream=codec_name,width,height,r_frame_rate \
            -show_entries format=duration,size,bit_rate -of default=noprint_wrappers=1 "$in"
    ;;

  gif)
    width="${2:-960}"; fps="${3:-15}"
    out="$dir/$stem-gif.gif"; pal="$dir/.palette-$$.png"
    say "转 GIF：${width}px / ${fps}fps（两遍调色板法，颜色质量和体积都比直出好）"
    ffmpeg -hide_banner -loglevel error -y -i "$in" \
      -vf "fps=$fps,scale=$width:-1:flags=lanczos,palettegen=stats_mode=diff" "$pal" \
      || { rm -f "$pal"; die "调色板生成失败"; }
    ffmpeg -hide_banner -loglevel error -y -i "$in" -i "$pal" \
      -lavfi "fps=$fps,scale=$width:-1:flags=lanczos[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=3" "$out" \
      || { rm -f "$pal"; die "GIF 生成失败"; }
    rm -f "$pal"
    say "完成：$out （$(du -h "$out" | awk '{print $1}')）"
    ;;

  mp4|small)
    if [ "$cmd" = "small" ]; then crf="${2:-28}"; tag="-small"; else crf="${2:-23}"; tag="-h264"; fi
    out="$dir/$stem$tag.mp4"
    say "转 MP4（crf $crf）"
    ffmpeg -hide_banner -loglevel error -y -i "$in" \
      -c:v libx264 -crf "$crf" -preset medium -pix_fmt yuv420p -movflags +faststart \
      -c:a aac -b:a 128k "$out" || die "转码失败"
    say "完成：$out （$(du -h "$out" | awk '{print $1}')）"
    ;;

  trim)
    start="${2:-}"; dur="${3:-}"
    [ -z "$start" ] && die "用法：trim <输入> <起始时间> <时长>"
    out="$dir/$stem-trim.mov"
    say "裁剪：从 ${start} 起，取 ${dur:-到结尾}"
    if [ -n "$dur" ]; then
      ffmpeg -hide_banner -loglevel error -y -ss "$start" -i "$in" -t "$dur" -c copy "$out" || die "裁剪失败"
    else
      ffmpeg -hide_banner -loglevel error -y -ss "$start" -i "$in" -c copy "$out" || die "裁剪失败"
    fi
    say "完成：$out （$(du -h "$out" | awk '{print $1}')）"
    ;;

  frame)
    sec="${2:-1}"
    out="$dir/$stem-frame.png"
    ffmpeg -hide_banner -loglevel error -y -ss "$sec" -i "$in" -frames:v 1 "$out" || die "抽帧失败"
    say "完成：$out"
    ;;

  *) die "未知动作：${cmd}（gif / mp4 / small / trim / frame / info）" ;;
esac
