// Structured data (JSON-LD) for Google
var sd = document.createElement('script');
sd.type = 'application/ld+json';
sd.text = JSON.stringify({
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  'name': 'Meridian — DevOps Gate',
  'description': 'A hard-blocking change gate for AI-generated code. Self-hosted, Apache-2.0, free alternative to Semgrep, GHAS and SonarQube.',
  'url': 'https://oss.kurvenschule.cloud',
  'downloadUrl': 'https://github.com/weilmaschinchen/meridian',
  'softwareVersion': '0.1.0',
  'operatingSystem': 'Linux, Docker',
  'applicationCategory': 'DeveloperApplication',
  'offers': {'@type': 'Offer', 'price': '0', 'priceCurrency': 'USD'},
  'license': 'https://www.apache.org/licenses/LICENSE-2.0'
});
document.head.appendChild(sd);
