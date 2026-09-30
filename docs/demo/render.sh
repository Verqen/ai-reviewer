#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/../.."

frames=docs/demo/frames
rm -rf "$frames"
vhs docs/demo/demo.tape

ffmpeg -v error -y \
  -loop 1 -i docs/demo/window.png \
  -framerate 50 -i "$frames/frame-text-%05d.png" \
  -framerate 50 -i "$frames/frame-cursor-%05d.png" \
  -filter_complex "[1:v][2:v]overlay[term];[0:v][term]overlay=28:62:shortest=1,fps=25,split[run][last];[last]reverse,trim=end_frame=1,loop=loop=74:size=1,setpts=N/25/TB[poster];[poster][run]concat=n=2:v=1,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=none" \
  docs/demo/demo.gif

rm -rf "$frames"
