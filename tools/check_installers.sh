#!/bin/bash
# check_installers.sh: every hosted installer must not touch what isn't ours.
# 2026-11-25: Mix Assistant 0.9.15's auto-setup wrote into FL Studio's settings and FL crashed on start. Never again.
# Fails if any hosted .exe names a DAW's settings (registry, user folders, FL Hardware scripts, MIDI port settings)
# or an autostart (Run keys, Startup folder, scheduled tasks, services). Same patterns as the source repo's
# tools/check_no_daw_writes.sh; rules in its docs/SAFETY.md. Limit: compressed installers (AutoSnip, 7z) hide their text.
R=$(cd "$(dirname "$0")/.." && pwd)
DAW='Image-Line[\\/]|Software[\\/]+Ableton|Ableton[\\/]+Live|Steinberg[\\/]+Cubase|Cockos[\\/]+REAPER|PreSonus[\\/]+Studio One|Avid[\\/]+Pro Tools|Bitwig Studio[\\/]|Settings[\\/]+Hardware|Devices[\\/]+MIDI'
AUTO='CurrentVersion[\\/]+Run|schtasks|Programs[\\/]+Startup|CreateService[AW]|Image File Execution|[\\/]Winlogon'
# Old Hub builds whose removed emergency button only DELETED the bad FL entry 0.9.15/0.9.16 wrote. Nothing new may be added here.
OLD='hub/YoukaiDigitalHub-Setup-1\.5[01]\.exe$'
bad=0; n=0
while IFS= read -r b; do
  n=$((n+1)); echo "$b" | grep -qE "$OLD" && continue
  hit=$({ strings -a "$b"; strings -a -el "$b"; } | grep -E "$DAW|$AUTO" | sort -u | head -5)
  [ -n "$hit" ] && { echo "$b:"; echo "$hit" | sed 's/^/    /'; bad=1; }
done < <(find "$R" -name '*.exe*' -not -path '*/.git/*' | sort)
[ $bad = 0 ] && { echo "check_installers: OK ($n files)"; exit 0; }
echo "check_installers: FAILED - an installer touches a DAW's settings or an autostart. Do not host it."; exit 1
