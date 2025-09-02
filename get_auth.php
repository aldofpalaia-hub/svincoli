<?php
// /svincoli/get_auth.php
// Serve auth.json solo se arriva il token corretto via Authorization: Bearer <TOKEN>

$expected = 'fantacalcio'; // puoi cambiarlo quando vuoi, ricordati di aggiornare il secret in GitHub

// Alcuni stack mettono l'header qui:
$hdr = $_SERVER['HTTP_AUTHORIZATION'] ?? '';
// Fallback (Apache/FastCGI):
if (!$hdr && isset($_SERVER['REDIRECT_HTTP_AUTHORIZATION'])) {
  $hdr = $_SERVER['REDIRECT_HTTP_AUTHORIZATION'];
}

if (!preg_match('/^Bearer\s+(.+)$/i', $hdr, $m) || $m[1] !== $expected) {
  http_response_code(403);
  header('Content-Type: text/plain; charset=utf-8');
  exit('Forbidden');
}

// Percorso del file sul server
$path = __DIR__ . '/auth_min.json'; // o 'auth.json' se non hai fatto il minify
if (!is_readable($path)) {
  http_response_code(404);
  header('Content-Type: text/plain; charset=utf-8');
  exit('Not found');
}

header('Content-Type: application/json; charset=utf-8');
header('Cache-Control: no-store, no-cache, must-revalidate, max-age=0');
readfile($path);
