# SPDX-License-Identifier: Apache-2.0
# MkDocs hook: inject Open Graph + canonical meta tags
import re

OG_TEMPLATE = '''
<meta property="og:type" content="website">
<meta property="og:site_name" content="Meridian — DevOps Gate">
<meta property="og:image" content="https://your-meridian-instance.example.com/assets/og-card.png">
<meta name="twitter:card" content="summary">
<meta name="keywords" content="devops gate,change management,AI code review,semgrep alternative,self-hosted,apache-2.0,WORM audit,LLM code review">
'''

def on_page_content(html, *, page, config, **kwargs):
    return html

def on_post_page(output, *, page, config, **kwargs):
    title = page.title or config['site_name']
    desc = config['site_description']
    if hasattr(page, 'meta') and page.meta:
        desc = page.meta.get('description', desc)
    canonical = config['site_url'].rstrip('/') + '/' + page.url
    inject = OG_TEMPLATE
    inject += f'<meta property="og:title" content="{title}">\n'
    inject += f'<meta property="og:description" content="{desc}">\n'
    inject += f'<meta property="og:url" content="{canonical}">\n'
    inject += f'<link rel="canonical" href="{canonical}">\n'
    return output.replace('</head>', inject + '</head>', 1)
