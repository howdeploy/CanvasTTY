# Even G2 browser and speech scope

The implemented companion reads and controls shared terminal sessions, creates supported agent sessions and submits push-to-talk dictation. Its Browser action opens the existing browser on the computer.

Full browser navigation from the glasses is future work: readable-page extraction, element selection, scrolling, typed/voice interaction, explicit confirmations and return to the original terminal would need their own interaction and safety contracts. No webpage screenshot or link-selection HUD is advertised as implemented.

Speech recognition currently runs locally on the Mac through the bundled transcribe.cpp/Nemotron path or a supported Handy installation. G2 PCM enters the recognition helper directly. External speech applications such as Wispr Flow are not integrated, and G2 audio is not exposed as a general OS microphone by this feature.

Future browser or speech-provider integrations should preserve per-session grants, require real microphone acknowledgements and include physical glasses acceptance. See [the current setup and limitations](even-g2.md).
