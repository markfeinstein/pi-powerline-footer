from pathlib import Path

OUT = Path('docs/screenshots')
OUT.mkdir(parents=True, exist_ok=True)

rows = [
    {
        'name': 'default',
        'title': 'Default preset',
        'config': 'preset: default',
        'bar': 'π  main   shell ▸ path ▸ git                 12%/272k  5m',
        'secondary': 'context_total · time_spent · time',
    },
    {
        'name': 'custom',
        'title': 'Custom layout',
        'config': 'preset: custom\ncustom: git | path | model | thinking   /   time_spent',
        'bar': 'π  git ▸ path ▸ model ▸ think ▸ cache       17%/272k',
        'secondary': 'extension_statuses',
    },
]

w = 1280
h = 420
row_h = 180


def esc(s: str) -> str:
    return (
        s.replace('&', '&amp;')
         .replace('<', '&lt;')
         .replace('>', '&gt;')
    )

sheet = [
    f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',
    '<rect width="100%" height="100%" fill="#0b0f14"/>',
    '<style>.t{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:#e8eef7}.muted{fill:#9aa7b8}.chip{fill:#17202b;stroke:#2b3a4a;stroke-width:1}.bar{fill:#111827;stroke:#334155;stroke-width:1}</style>',
]

for i, row in enumerate(rows):
    y = 24 + i * row_h
    sheet.append(f'<text class="t" x="32" y="{y}" font-size="24" font-weight="700">{esc(row["title"])} </text>')
    sheet.append(f'<text class="t muted" x="32" y="{y+26}" font-size="16">{esc(row["config"])} </text>')
    sheet.append(f'<rect class="bar" x="32" y="{y+42}" rx="12" ry="12" width="1216" height="92"/>')
    sheet.append(f'<text class="t" x="52" y="{y+82}" font-size="22">{esc(row["bar"])} </text>')
    sheet.append(f'<text class="t muted" x="52" y="{y+110}" font-size="16">{esc(row["secondary"])} </text>')

sheet.append('</svg>')
(OUT / 'custom-layout-contact-sheet.svg').write_text('\n'.join(sheet))

single = [
    '<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="240" viewBox="0 0 1280 240">',
    '<rect width="100%" height="100%" fill="#0b0f14"/>',
    '<style>.t{font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;fill:#e8eef7}.muted{fill:#9aa7b8}.bar{fill:#111827;stroke:#334155;stroke-width:1}</style>',
    '<text class="t" x="32" y="36" font-size="24" font-weight="700">Custom layout screenshot</text>',
    '<text class="t muted" x="32" y="62" font-size="16">preset: custom · current docs sample</text>',
    '<rect class="bar" x="32" y="84" rx="12" ry="12" width="1216" height="92"/>',
    '<text class="t" x="52" y="124" font-size="22">π  git ▸ path ▸ model ▸ think ▸ cache       17%/272k</text>',
    '<text class="t muted" x="52" y="152" font-size="16">extension_statuses</text>',
    '</svg>',
]
(OUT / 'custom-layout.svg').write_text('\n'.join(single))
print('wrote docs/screenshots/custom-layout.svg and custom-layout-contact-sheet.svg')
