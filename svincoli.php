<?php
declare(strict_types=1);

require __DIR__ . '/vendor/autoload.php';

use PhpOffice\PhpSpreadsheet\IOFactory;
use PhpOffice\PhpSpreadsheet\Worksheet\Worksheet;
use PhpOffice\PhpSpreadsheet\Cell\Coordinate;
use GuzzleHttp\Client;

/* ========================== CONFIG ========================== */

const ROSTERS_XLSX = __DIR__ . '/negher rosters.xlsx';        // file con le rose
const PAGE_URL     = 'https://www.fantacalcio.it/quotazioni-fantacalcio'; // Mantra 2025/26
const PRICES_URL   = 'https://www.fantacalcio.it/api/v1/Excel/prices/20/1'; // spesso 401
const CACHE_DIR    = __DIR__ . '/cache';
const CACHE_XLSX   = CACHE_DIR . '/prices.xlsx';  // cache da upload Excel
const CACHE_JSON   = CACHE_DIR . '/prices.json';  // cache da scraping / incolla
const MAX_UPLOAD_B = 8 * 1024 * 1024;            // 8 MB
const UA_BROWSER   = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome Safari';
const CAMPIONCINO_PATH_SEASON = '20';            // cartella stagione per campioncini

/* ========================== UTILS =========================== */

function norm(string $s): string {
    $s = trim($s);
    $t = @iconv('UTF-8', 'ASCII//TRANSLIT//IGNORE', $s);
    if ($t !== false && $t !== '') $s = $t;
    $s = strtolower($s);
    $s = preg_replace('/[^a-z0-9\s]/u', ' ', $s);
    $s = preg_replace('/\s+/', ' ', $s);
    return trim($s);
}
function half_up(float $v): int { return (int) round($v, 0, PHP_ROUND_HALF_UP); }
function ensureCacheDir(): void { if (!is_dir(CACHE_DIR)) mkdir(CACHE_DIR, 0775, true); }
function humanDT($ts): string { return (is_int($ts) && $ts > 0) ? date('d/m/Y H:i', $ts) : 'n/d'; }
function numify($v): float {
    $s = trim((string)$v);
    if ($s==='') return 0.0;
    $s = preg_replace('/[.\s]/', '', $s); // separatori migliaia
    $s = str_replace(',', '.', $s);       // virgola -> punto
    return (float)$s;
}
function cellVal(Worksheet $sh, int $col, int $row) {
    $addr = Coordinate::stringFromColumnIndex($col) . $row;
    return $sh->getCell($addr)->getValue();
}
function cellCalc(Worksheet $sh, int $col, int $row) {
    $addr = Coordinate::stringFromColumnIndex($col) . $row;
    return $sh->getCell($addr)->getCalculatedValue();
}
function getLogoDataUrl(): ?string {
    foreach (['logo.jpg','logo.jpeg','logo.png'] as $f) {
        $p = __DIR__ . '/' . $f;
        if (is_file($p)) {
            $mime = str_ends_with($f, '.png') ? 'image/png' : 'image/jpeg';
            return "data:$mime;base64," . base64_encode((string)file_get_contents($p));
        }
    }
    return null;
}
function findHeader(array $headers, array $cands): int {
    foreach ($cands as $c) { $i = array_search(strtolower($c), $headers, true); if ($i !== false) return (int)$i; }
    return -1;
}

/* =================== AZIONI (UPLOAD/PASTE/FETCH) ============= */

$flash = null; $flashType = 'info';

// Upload Excel prezzi
if (($_POST['action'] ?? '') === 'upload_prices' && isset($_FILES['prices_xlsx'])) {
    try {
        if (!is_uploaded_file($_FILES['prices_xlsx']['tmp_name'])) throw new RuntimeException('Upload non valido.');
        if ((int)$_FILES['prices_xlsx']['size'] > MAX_UPLOAD_B) throw new RuntimeException('File troppo grande (max 8MB).');
        $ext = strtolower(pathinfo($_FILES['prices_xlsx']['name'], PATHINFO_EXTENSION));
        if ($ext !== 'xlsx') throw new RuntimeException('Carica un file Excel .xlsx');
        ensureCacheDir();
        @unlink(CACHE_JSON);
        if (!move_uploaded_file($_FILES['prices_xlsx']['tmp_name'], CACHE_XLSX)) throw new RuntimeException('Impossibile salvare il file.');
        $flash = 'Listino Excel caricato.'; $flashType = 'ok';
    } catch (Throwable $e) { $flash = 'Errore upload: '.$e->getMessage(); $flashType = 'err'; }
}

// Incolla CSV/TSV dalla pagina
if (($_POST['action'] ?? '') === 'paste_prices') {
    try {
        $txt = (string)($_POST['prices_paste'] ?? '');
        $map = parsePastedPricesToMap($txt);
        if (!$map) throw new RuntimeException('Formato non riconosciuto. Servono intestazioni: Calciatore, Squadra, QI, QA (opz. Ruolo).');
        ensureCacheDir(); file_put_contents(CACHE_JSON, json_encode($map, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
        @unlink(CACHE_XLSX);
        $flash = 'Listino salvato dai dati incollati.'; $flashType = 'ok';
    } catch (Throwable $e) { $flash = 'Errore incolla: '.$e->getMessage(); $flashType = 'err'; }
}

// Scraping dalla pagina (Mantra 25/26)
if (($_GET['action'] ?? '') === 'fetch_web') {
    try {
        $map = scrapePricesFromPage(PAGE_URL);
        if (!$map) throw new RuntimeException('Nessun dato estratto.');
        ensureCacheDir(); file_put_contents(CACHE_JSON, json_encode($map, JSON_UNESCAPED_UNICODE|JSON_PRETTY_PRINT));
        @unlink(CACHE_XLSX);
        $flash = 'Listino aggiornato dalla pagina (Mantra 25/26).'; $flashType = 'ok';
    } catch (Throwable $e) { $flash = 'Errore fetch web: '.$e->getMessage(); $flashType = 'err'; }
}

/* ====================== ROSTERS READER ======================= */

function loadRosters(string $xlsxPath): array {
    if (!file_exists($xlsxPath)) throw new RuntimeException("File roster non trovato: " . basename($xlsxPath));
    $spreadsheet = IOFactory::load($xlsxPath);
    $sheet = $spreadsheet->getSheetByName('TutteLeRose') ?? $spreadsheet->getSheet(0);

    // 1) Parser layout "TutteLeRose" (blocchi 4 colonne)
    $teams = parseNegherGrid($sheet);
    if (!empty($teams)) return $teams;

    // 2) Fallback: vecchio layout “coppie di colonne” (Team | Costo)
    $teams = parseColumnPairs($sheet);
    if (!empty($teams)) return $teams;

    throw new RuntimeException('Formato roster non riconosciuto. Attesi blocchi "Ruolo/Calciatore/Squadra/Costo" o colonne (Team|Costo).');
}

/** Blocchi da 4 colonne: [Ruolo | Calciatore | Squadra | Costo] */
function parseNegherGrid(Worksheet $sheet): array {
    $highestRow = $sheet->getHighestRow();
    $highestCol = Coordinate::columnIndexFromString($sheet->getHighestColumn());
    if ($highestCol < 4) return [];

    $teams = [];

    for ($r = 1; $r <= $highestRow - 1; $r++) {
        for ($c = 1; $c <= $highestCol - 3; $c++) {
            $h1 = strtolower(trim((string) cellVal($sheet, $c,     $r+1)));
            $h2 = strtolower(trim((string) cellVal($sheet, $c + 1, $r+1)));
            $h3 = strtolower(trim((string) cellVal($sheet, $c + 2, $r+1)));
            $h4 = strtolower(trim((string) cellVal($sheet, $c + 3, $r+1)));

            if ($h1 === 'ruolo' && $h2 === 'calciatore' && $h3 === 'squadra' && str_contains($h4, 'costo')) {
                $teamName = trim((string) cellVal($sheet, $c, $r));
                if ($teamName === '' || preg_match('/^crediti residui/i', $teamName) || preg_match('/^https?:\/\//i', $teamName)) {
                    continue;
                }
                $row = $r + 2;
                while ($row <= $highestRow) {
                    $ruolo = trim((string) cellVal($sheet, $c,     $row));
                    $nome  = trim((string) cellVal($sheet, $c + 1, $row));
                    $squad = trim((string) cellVal($sheet, $c + 2, $row));
                    $costo = cellCalc($sheet, $c + 3, $row);

                    $left = strtolower($ruolo);
                    if (($ruolo === '' && $nome === '' && $squad === '') || str_starts_with($left, 'crediti residui')) break;

                    if ($nome !== '') {
                        $teams[$teamName][] = ['player'=>$nome, 'costo'=>(float)$costo, 'ruolo'=>$ruolo];
                    }
                    $row++;
                }
                $c += 3; // salta blocco
            }
        }
    }
    return $teams;
}

/** Fallback storico: colonne a coppie [Nome squadra | Costo] (nessun ruolo disponibile) */
function parseColumnPairs(Worksheet $sheet): array {
    $highestRow = $sheet->getHighestRow();
    $highestCol = Coordinate::columnIndexFromString($sheet->getHighestColumn());
    $teams = [];
    for ($col = 1; $col <= $highestCol; $col++) {
        $header     = (string) cellVal($sheet, $col, 1);
        $nextHeader = $col + 1 <= $highestCol ? (string) cellVal($sheet, $col + 1, 1) : '';
        if ($header !== '' && preg_match('/costo/i', $nextHeader)) {
            $teamName = trim($header);
            for ($row = 2; $row <= $highestRow; $row++) {
                $player = (string) cellVal($sheet, $col, $row);
                if ($player === '' || strtoupper($player) === 'N/A') continue;
                $costo  = cellCalc($sheet, $col + 1, $row);
                if ($costo === null || $costo === '') continue;
                $teams[$teamName][] = ['player'=>trim($player), 'costo'=>(float)$costo, 'ruolo'=>''];
            }
            $col++; // salta "Costo"
        }
    }
    return $teams;
}

/* ======================= PREZZI (3 fonti) ===================== */

function loadPriceList(): array {
    // 1) JSON da scraping/incolla
    if (file_exists(CACHE_JSON)) {
        $arr = json_decode((string)file_get_contents(CACHE_JSON), true);
        if (is_array($arr)) return $arr;
    }
    // 2) Excel da upload
    if (file_exists(CACHE_XLSX)) {
        return loadPriceListXlsx(CACHE_XLSX);
    }
    // 3) Tentativo Excel remoto (spesso 401)
    try {
        $client = new Client(['timeout'=>25,'headers'=>['User-Agent'=>'NegherLeague Svincoli/1.6']]);
        $res = $client->get(PRICES_URL);
        if ($res->getStatusCode()===200){
            ensureCacheDir();
            file_put_contents(CACHE_XLSX, $res->getBody()->getContents());
            return loadPriceListXlsx(CACHE_XLSX);
        }
    } catch (\Throwable $e) { /* ignoriamo */ }
    throw new RuntimeException('Nessun listino disponibile. Usa “Aggiorna da pagina”, “Carica Excel” o “Incolla dati”.');
}

function loadPriceListXlsx(string $file): array {
    $ss = IOFactory::load($file);
    $sh = $ss->getSheet(0);

    $headers = [];
    $maxC = Coordinate::columnIndexFromString($sh->getHighestColumn());
    for ($c=1; $c<=$maxC; $c++) {
        $h = strtolower(trim((string)cellVal($sh, $c, 1)));
        if ($h!=='') $headers[$h] = $c;
    }
    $colNome = $headers['nome'] ?? $headers['calciatore'] ?? 1;
    $colRuolo= $headers['ruolo'] ?? 2;
    $colSq   = $headers['squadra'] ?? $headers['team'] ?? 3;
    $colQA   = $headers['quotazione'] ?? $headers['q attuale'] ?? 4;
    $colQI   = $headers['quotazione iniziale'] ?? $headers['q iniziale'] ?? 5;
    $colID   = $headers['id'] ?? $headers['id calciatore'] ?? $headers['calciatore id'] ?? null; // opzionale

    $map = [];
    $maxR = $sh->getHighestRow();
    for ($r=2; $r<=$maxR; $r++) {
        $nome = trim((string)cellVal($sh, $colNome, $r));
        if ($nome==='') continue;
        $ruolo = (string)cellVal($sh, $colRuolo, $r);
        $sq    = (string)cellVal($sh, $colSq,    $r);
        $qa    = numify(cellCalc($sh, $colQA,    $r));
        $qi    = numify(cellCalc($sh, $colQI,    $r));
        $id    = $colID ? trim((string)cellVal($sh, $colID, $r)) : '';
        if ($qi<=0) continue;

        $map[norm($nome)] = [
            'nome'=>$nome,'ruolo'=>$ruolo,'squadra'=>$sq,'q_att'=>$qa,'q_ini'=>$qi,
            'id'=>$id !== '' ? $id : null,
        ];
    }
    return $map;
}

/* ===================== SCRAPING (Mantra + Ruoli + ID) ========= */

function extractRoleToken(string $s): string {
    $rx = '/(?<![A-Za-zÀ-ÖØ-öø-ÿ])(Por|Dc|Dd|Ds|E|M|C|W|T|A|Pc)(?![A-Za-zÀ-ÖØ-öø-ÿ])/u';
    return preg_match($rx, $s, $m) ? $m[1] : '';
}

function scrapePricesFromPage(string $url): array {
    $client = new Client([
        'timeout' => 25,
        'headers' => [
            'User-Agent'      => UA_BROWSER,
            'Accept'          => 'text/html,application/xhtml+xml',
            'Accept-Language' => 'it-IT,it;q=0.9,en;q=0.8',
        ],
    ]);
    $res = $client->get($url);
    if ($res->getStatusCode() !== 200) throw new RuntimeException('HTTP '.$res->getStatusCode());

    $html = (string)$res->getBody();

    // 1) Cattura anchor dei profili: .../serie-a/squadre/<team>/<slug>/<ID>
    $nameToId = [];
    if (preg_match_all(
        '#<a[^>]+href="(?:https?:\/\/www\.fantacalcio\.it)?\/serie-a\/squadre\/[^\/]+\/[^\/]+\/(\d+)"[^>]*>(.*?)<\/a>#si',
        $html, $m, PREG_SET_ORDER
    )) {
        foreach ($m as $x) {
            $id   = trim($x[1]);
            $name = trim(html_entity_decode(strip_tags($x[2]), ENT_QUOTES|ENT_HTML5, 'UTF-8'));
            if ($name !== '' && $id !== '') {
                $nameToId[norm($name)] = $id; // es. "martinez l" => "2764"
            }
        }
    }

    // 2) Pulisci/linearizza il testo per il parser
    $clean  = preg_replace('#<script[^>]*>.*?</script>#is', '', $html);
    $clean  = preg_replace('#<style[^>]*>.*?</style>#is',  '', $clean);
    $txt    = html_entity_decode(strip_tags($clean), ENT_QUOTES|ENT_HTML5, 'UTF-8');
    $txt    = str_replace(["\xC2\xA0", "\xE2\x80\xAF", "\xEF\xBB\xBF"], ' ', $txt);
    $txt    = preg_replace('/[ \t]+/u', ' ', $txt);
    $txt    = preg_replace('/\R+/u', "\n", $txt);

    // 3) Parser righe listino (Mantra)
    $pattern = '/(^|[\n\r])\s*' .
               '([A-Za-zÀ-ÖØ-öø-ÿ0-9\.\'\- ]{2,})\s+' . // nome come in lista (es. "Martinez L.")
               '([A-Z]{2,3})\s+' .                      // squadra (sigla)
               '(\d{1,3})\s+(\d{1,3})\s+[\d,.]{1,5}\s+' .
               '(\d{1,3})\s+(\d{1,3})\s+[\d,.]{1,5}\s*(?=\n|$)/u';

    if (!preg_match_all($pattern, $txt, $rows, PREG_SET_ORDER)) {
        throw new RuntimeException('Parser: nessuna riga trovata. Assicurati Mantra + 2025/26.');
    }

    $map = [];
    foreach ($rows as $r) {
        $full  = $r[0];
        $nome  = trim($r[2]);            // es. "Martinez L."
        $squad = trim($r[3]);
        $qi2   = (float)$r[6];
        $qa2   = (float)$r[7];
        if ($qi2 <= 0) continue;

        // ruolo dal testo prima del nome
        $pos    = mb_stripos($full, $nome);
        $before = $pos !== false ? mb_substr($full, 0, $pos) : $full;
        $ruolo  = extractRoleToken($before);

        $k = norm($nome);
        $map[$k] = [
            'nome'    => $nome,
            'ruolo'   => $ruolo,
            'squadra' => $squad,
            'q_att'   => $qa2,
            'q_ini'   => $qi2,
            'id'      => $nameToId[$k] ?? null,  // ID se trovato
        ];
    }
    if (!$map) throw new RuntimeException('Parser: nessun dato utile estratto.');
    return $map;
}

/* ===================== PASTE PARSER (CSV/TSV) ================== */

function parsePastedPricesToMap(string $txt): array {
    $txt = trim($txt);
    if ($txt==='') return [];
    $first = strtok($txt, "\r\n");
    $sep = (strpos($first, "\t") !== false) ? "\t" : ((strpos($first,';')!==false)?';':',');

    $lines = preg_split('/\r\n|\r|\n/', $txt);
    if (!$lines || count($lines) < 2) return [];

    $headers = array_map(fn($h) => strtolower(trim($h)), str_getcsv(array_shift($lines), $sep));
    $idx = [
        'ruolo'  => findHeader($headers, ['ruolo']),
        'nome'   => findHeader($headers, ['calciatore','nome','giocatore']),
        'squadra'=> findHeader($headers, ['squadra','sq']),
        'qi'     => findHeader($headers, ['qi','q iniziale','quotazione iniziale']),
        'qa'     => findHeader($headers, ['qa','q attuale','quotazione']),
        // notare: Incolla raramente ha l'ID; se presente puoi estendere qui
    ];
    if ($idx['nome']===-1 || $idx['qi']===-1 || $idx['qa']===-1) return [];

    $map = [];
    foreach ($lines as $line) {
        if (!trim($line)) continue;
        $cols = str_getcsv($line, $sep);
        $nome  = trim((string)($cols[$idx['nome']] ?? '')); if ($nome==='') continue;
        $ruolo = $idx['ruolo']   !== -1 ? trim((string)($cols[$idx['ruolo']]   ?? '')) : '';
        $squad = $idx['squadra'] !== -1 ? trim((string)($cols[$idx['squadra']] ?? '')) : '';
        $qi    = $idx['qi']      !== -1 ? numify($cols[$idx['qi']]) : 0.0;
        $qa    = $idx['qa']      !== -1 ? numify($cols[$idx['qa']]) : 0.0;
        if ($qi <= 0) continue;
        $map[norm($nome)] = ['nome'=>$nome,'ruolo'=>$ruolo,'squadra'=>$squad,'q_att'=>$qa,'q_ini'=>$qi];
    }
    return $map;
}

/* =================== MATCHING NOMI ROBUSTO ==================== */

/**
 * Cerca una riga prezzi partendo dal nome roster, con fallback:
 *  - chiave esatta (norm)
 *  - cognome + iniziale nome (es. "martinez l")
 *  - ultimi due token ("joao pedro", "mario rui", "luis alberto")
 *  - particelle (di/de/van/…)
 *  - se un solo match per cognome*, usa quello
 */
function fc_find_price_row(array $priceMap, string $playerName): ?array {
    $k = norm($playerName);
    if (isset($priceMap[$k])) return $priceMap[$k];

    $tokens = preg_split('/\s+/', $k);
    $tokens = array_values(array_filter($tokens, fn($t)=>$t!==''));
    $n = count($tokens);
    if ($n === 0) return null;

    $last  = $tokens[$n-1];
    $first = $tokens[0];

    // 1) cognome + iniziale nome
    if ($n >= 2) {
        $cand = $last.' '.substr($first,0,1);
        if (isset($priceMap[$cand])) return $priceMap[$cand];
    }
    // 2) ultimi due token (per doppi nomi)
    if ($n >= 2) {
        $cand = $tokens[$n-2].' '.$last;
        if (isset($priceMap[$cand])) return $priceMap[$cand];
    }
    // 3) cognome con particella
    $particles = ['di','de','del','della','da','dal','d','van','von','la','le','lo','mac','mc','bin','al'];
    if ($n >= 3 && in_array($tokens[$n-2], $particles, true)) {
        $cand = $tokens[$n-2].' '.$last;
        if (isset($priceMap[$cand])) return $priceMap[$cand];
    }
    // 4) unico match per cognome*
    $matches = [];
    foreach ($priceMap as $key => $row) {
        if (preg_match('/^'.preg_quote($last, '/').'\s+[a-z]/', $key)) {
            $matches[] = $key;
            if (count($matches) > 1) break;
        }
    }
    if (count($matches) === 1) return $priceMap[$matches[0]];

    return null;
}

/* =================== CALCOLO RIMBORSO SQUADRA ================= */

function computeTeamPayouts(array $teamPlayers, array $priceMap): array {
    $rows = [];
    foreach ($teamPlayers as $row) {
        $playerName = $row['player'];
        $purchase   = (float)$row['costo'];
        $ruoloRoster= (string)($row['ruolo'] ?? '');
        $key = norm($playerName);
        $found = $priceMap[$key] ?? fc_find_price_row($priceMap, $playerName);

        if ($found) {
            $qAtt = (float)$found['q_att'];
            $qIni = (float)$found['q_ini'];
            $raw  = $qIni > 0 ? ($purchase * $qAtt) / $qIni : 0.0;
            $rows[] = [
                'player'   => $found['nome'],
                'ruolo'    => $ruoloRoster !== '' ? $ruoloRoster : (string)($found['ruolo'] ?? ''),
                'squadra'  => $found['squadra'],
                'acquisto' => $purchase,
                'q_att'    => $qAtt,
                'q_ini'    => $qIni,
                'calc'     => $raw,
                'rimborso' => half_up($raw),
                'match'    => 'OK',
                'id'       => $found['id'] ?? null,   // per campioncini
            ];
        } else {
            $rows[] = [
                'player'=>$playerName,'ruolo'=>$ruoloRoster,'squadra'=>'',
                'acquisto'=>$purchase,'q_att'=>null,'q_ini'=>null,'calc'=>null,'rimborso'=>null,'match'=>'NON TROVATO'
            ];
        }
    }
    return $rows;
}

/* =========================== CONTROLLER ======================= */

$error = null; $teams=[]; $prices=[];
$selectedTeam = $_GET['team'] ?? '';

try { $teams = loadRosters(ROSTERS_XLSX); } catch (Throwable $e) { $error = $e->getMessage(); }
try { if (!$error) $prices = loadPriceList(); } catch (Throwable $e) { $error = $e->getMessage(); }

$teamNames = array_keys($teams);
if ($selectedTeam && !in_array($selectedTeam, $teamNames, true)) $selectedTeam = '';
$results = ($selectedTeam && isset($teams[$selectedTeam])) ? computeTeamPayouts($teams[$selectedTeam], $prices) : [];
$logoUrl = getLogoDataUrl();

/* ============================ VIEW =========================== */
/* Campioncino via ID ufficiale (card -> fallback small) */

function fc_guess_camp_id_from_row(array $r): ?string {
  foreach (['id','Id','camp_id','id_campioncino','IdCalciatore','PlayerId','id_giocatore','Codice','cod'] as $k) {
    if (!empty($r[$k])) return (string)$r[$k];
  }
  return null;
}
function campioncino_img_auto(string $player, ?string $id = null, string $class='campioncino'): string {
  if (!$id) return '';
  $base  = 'https://content.fantacalcio.it/web/campioncini/'.CAMPIONCINO_PATH_SEASON.'/';
  $card  = $base.'card/'.$id.'.png?v=342';
  $small = $base.'small/'.$id.'.png?v=342';
  $onerr = "this.onerror=null;this.src='".htmlspecialchars($small, ENT_QUOTES)."';";
  return '<img alt="" class="'.htmlspecialchars($class,ENT_QUOTES).'" src="'.htmlspecialchars($card,ENT_QUOTES).'" onerror="'.$onerr.'">';
}

?>
<!doctype html>
<html lang="it" data-bs-theme="dark">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>NegherLeague • Svincoli</title>
<link href="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/css/bootstrap.min.css" rel="stylesheet">
<style>
:root{ --brand-primary:#f39c12; --brand-dark:#0b0d10; }
body{background:var(--brand-dark); color:#e8eef2}
.navbar{background:#10151b;border-bottom:1px solid #1f2630}
.navbar-brand{display:flex;align-items:center;gap:.6rem;font-weight:700}
.navbar-brand img{height:40px;width:auto;border-radius:8px}
.card{background:#12161b;border:1px solid #1f2630;border-radius:14px}
.badge-outline{border:1px solid #2a3340;background:#0f1318;color:#aeb8c5}
.table>:not(caption)>*>*{border-bottom-color:#243041}
.btn-primary{--bs-btn-bg:var(--brand-primary);--bs-btn-border-color:var(--brand-primary);--bs-btn-hover-bg:#d8870c;--bs-btn-hover-border-color:#d8870c}
.sticky-summary{position:sticky; bottom:0; background:#0f1318; border-top:1px solid #1f2630; padding:.75rem 1rem;}
.player-cell{display:flex;align-items:center;gap:.5rem}
.campioncino{width:28px;height:28px;object-fit:contain;border-radius:6px}
.player-open{display:flex;align-items:center;gap:.5rem;text-decoration:none;color:inherit}
.player-open:hover .player-name{text-decoration:underline}
/* nascondi colonne superflue su mobile: mostrale da sm in su */
@media (max-width: 575.98px){
  .col-mobile-hide{display:none!important}
}
/* evita scroll orizzontale su mobile e fai occupare tutta la larghezza */
.table-responsive.table-center{ overflow-x: visible; }

@media (max-width:575.98px){
  .table-responsive.table-center{
    overflow-x: hidden !important;          /* niente “slide” a sinistra/destra */
    touch-action: pan-y;                     /* consenti solo scroll verticale */
    -webkit-overflow-scrolling: auto;
  }
  .table-center .table{
    width:100% !important;                   /* riempi tutto, niente spazio a destra */
    table-layout: fixed;                     /* colonne stabili */
  }
  .table-center .table th,
  .table-center .table td{
    white-space: nowrap;                     /* evita a capo brutti */
  }
  .player-name{ min-width:0; }               /* ellissi corretta sul nome */
}
/* Mobile: tabella a tutta larghezza, nessuno scroll orizzontale */
@media (max-width:575.98px){
  .table-responsive{ overflow-x:hidden !important; }

  /* la tabella riempie il contenitore */
  #tbl{
    width:100% !important;
    table-layout:auto;              /* più flessibile del fixed coi contenuti variabili */
    margin:0 !important;
    border-collapse:separate;
    border-spacing:0;
  }

  /* override dei min-width inline dei TH (180px/70px) */
  #tbl th{ min-width:0 !important; }

  /* la cella nome si adatta e va in ellissi */
  .player-cell{ min-width:0; }
  .player-open{ display:flex; align-items:center; gap:.5rem; min-width:0; }
  .player-name{ overflow:hidden; text-overflow:ellipsis; white-space:nowrap; min-width:0; }

  /* dimensiona le colonne visibili: Ruolo e Rimborso */
  #tbl th:nth-child(3), #tbl td:nth-child(3){ width:74px; }         /* Ruolo */
  #tbl th:nth-child(9), #tbl td:nth-child(9){ width:86px; text-align:right; } /* Rimborso */

  /* fix Safari/iOS: elimina il micro-gap destro */
  @supports (-webkit-touch-callout: none){
    #tbl{ width:calc(100% + 1px) !important; margin-right:-1px !important; }
  }
}

</style>
</head>
<body>
<nav class="navbar mb-4">
  <div class="container">
    <a class="navbar-brand" href="#">
      <?php if ($logoUrl): ?><img src="<?= htmlspecialchars($logoUrl) ?>" alt="NegherLeague logo"><?php endif; ?>
      <span>NegherLeague • Svincoli</span>
    </a>
  </div>
</nav>

<div class="container">

  <?php if ($error): ?>
    <div class="alert alert-danger">
      <strong>Errore:</strong> <?= htmlspecialchars($error) ?><br>
      Usa <em>Aggiorna da pagina</em>, <em>Carica Excel</em> oppure <em>Incolla dati</em>.
    </div>
  <?php endif; ?>

  <?php if (!empty($flash)): ?>
    <div class="alert <?= $flashType==='ok'?'alert-success':($flashType==='err'?'alert-danger':'alert-warning') ?>">
      <?= htmlspecialchars($flash) ?>
    </div>
  <?php endif; ?>

  <div class="card mb-4">
    <div class="card-body">
      <form class="row gy-3 gx-3 align-items-end" method="get" action="">
        <div class="col-12 col-md-6">
          <label for="team" class="form-label">Seleziona squadra</label>
          <select id="team" name="team" class="form-select" onchange="this.form.submit()">
            <option value="">— scegli —</option>
            <?php foreach ($teamNames as $t): ?>
              <option value="<?= htmlspecialchars($t) ?>" <?= $t===$selectedTeam?'selected':'' ?>><?= htmlspecialchars(mb_strtoupper($t,'UTF-8')) ?></option>
            <?php endforeach; ?>
          </select>
        </div>
        <div class="col-12 col-md-auto">
          <button type="submit" class="btn btn-primary">Calcola</button>
        </div>
        <div class="col-12 col-md-auto">
          <a class="btn btn-outline-light" href="?action=fetch_web<?= $selectedTeam ? '&team='.urlencode($selectedTeam) : '' ?>">Aggiorna da pagina (Mantra 25/26)</a>
        </div>
        <div class="col-12">
          <span class="badge badge-outline">Cache Excel: <?= htmlspecialchars(humanDT(@filemtime(CACHE_XLSX))) ?></span>
          <span class="badge badge-outline ms-2">Cache Web/Incolla: <?= htmlspecialchars(humanDT(@filemtime(CACHE_JSON))) ?></span>
          <span class="badge badge-outline ms-2">Formula: (Acquisto × QA) / QI → HALF UP</span>
        </div>
      </form>
    </div>
  </div>

  <?php if ($selectedTeam): ?>
    <div class="card mb-5">
      <div class="card-header d-flex justify-content-between align-items-center">
        <h5 class="mb-0"><?= htmlspecialchars(mb_strtoupper($selectedTeam,'UTF-8')) ?></h5>
        <span class="text-secondary small">Sorgente prezzi: <?= file_exists(CACHE_JSON) ? 'Web/Incolla' : (file_exists(CACHE_XLSX) ? 'Excel' : 'Remoto') ?></span>
      </div>
      <div class="card-body p-0">
        <div class="table-responsive px-0">
  <table id="tbl" class="table table-dark table-striped table-hover align-middle mb-0 w-100">
            <thead>
  <tr>
    <th class="col-mobile-hide" style="width:44px">
      <input class="form-check-input" type="checkbox" id="checkAll" title="Seleziona tutti">
    </th>
    <th style="min-width:180px">Calciatore</th>
    <th style="min-width:70px">Ruolo</th>
    <th class="col-mobile-hide">Squadra</th>
    <th class="col-mobile-hide">Acquisto</th>
    <th class="col-mobile-hide">Q. attuale</th>
    <th class="col-mobile-hide">Q. iniziale</th>
    <th class="col-mobile-hide">Calcolo grezzo</th>
    <th>Rimborso</th>
    <th class="col-mobile-hide">Match</th>
  </tr>
</thead>

 <tbody>
<?php $tot = 0; foreach ($results as $i => $r): $tot += (int)($r['rimborso'] ?? 0); ?>
  <?php
    $canSelect    = $r['rimborso'] !== null;
    $rim          = $r['rimborso'] !== null ? (int)$r['rimborso'] : 0;

    // Colore rimborso in base al confronto con l'acquisto
    $rimborsoVal  = $r['rimborso'];
    $acquistoVal  = (float)$r['acquisto'];
    if ($rimborsoVal !== null) {
        if ($rimborsoVal < $acquistoVal)      { $rimClass = 'text-danger'; } // rosso
        elseif ($rimborsoVal > $acquistoVal)  { $rimClass = 'text-success'; } // verde
        else                                   { $rimClass = 'text-white'; }  // bianco
    } else {
        $rimClass = 'text-muted'; // per il trattino '-'
    }
  ?>
  <tr class="<?= $r['match']==='OK' ? '' : 'table-warning' ?>">
    <td class="col-mobile-hide">
      <input class="row-check form-check-input" type="checkbox"
             <?= $canSelect ? '' : 'disabled' ?>
             data-rimborso="<?= htmlspecialchars((string)$rim) ?>">
    </td>

    <?php $campId = fc_guess_camp_id_from_row($r); ?>
    <td class="player-cell">
  <a href="#"
     class="player-open"              
     data-open="player"               
     data-id="<?= htmlspecialchars((string)$campId) ?>"
     data-team="<?= htmlspecialchars($selectedTeam) ?>"     
     data-player="<?= htmlspecialchars($r['player']) ?>"
     data-ruolo="<?= htmlspecialchars($r['ruolo']) ?>"
     data-squadra="<?= htmlspecialchars($r['squadra'] ?: '-') ?>"
     data-acquisto="<?= htmlspecialchars((string)$r['acquisto']) ?>"
     data-qatt="<?= htmlspecialchars((string)($r['q_att'] ?? '')) ?>"
     data-qini="<?= htmlspecialchars((string)($r['q_ini'] ?? '')) ?>"
     data-calc="<?= htmlspecialchars((string)($r['calc'] ?? '')) ?>"
     data-rimborso="<?= htmlspecialchars((string)($r['rimborso'] ?? '')) ?>"
     data-match="<?= htmlspecialchars($r['match']) ?>">
    <?= campioncino_img_auto($r['player'], $campId) ?>
    <span class="player-name"><?= htmlspecialchars($r['player']) ?></span>
  </a>
    </td>

    <td>
      <?php if (!empty($r['ruolo'])): ?>
        <span class="badge text-dark" style="background:var(--brand-primary)"><?= htmlspecialchars($r['ruolo']) ?></span>
      <?php else: ?><span class="text-muted">—</span><?php endif; ?>
    </td>

    <td class="col-mobile-hide"><?= htmlspecialchars($r['squadra'] ?: '-') ?></td>
    <td class="col-mobile-hide"><?= number_format((float)$r['acquisto'], 0, ',', '.') ?></td>
    <td class="col-mobile-hide"><?= $r['q_att']!==null ? number_format((float)$r['q_att'], 0, ',', '.') : '-' ?></td>
    <td class="col-mobile-hide"><?= $r['q_ini']!==null ? number_format((float)$r['q_ini'], 0, ',', '.') : '-' ?></td>
    <td class="col-mobile-hide"><?= $r['calc']!==null ? number_format((float)$r['calc'], 2, ',', '.') : '-' ?></td>

    <td>
      <strong class="<?= $rimClass ?>">
        <?= $rimborsoVal!==null ? number_format((int)$rimborsoVal, 0, ',', '.') : '-' ?>
      </strong>
    </td>

    <td class="col-mobile-hide">
      <?php if ($r['match']==='OK'): ?>
        <span class="badge text-bg-success">OK</span>
      <?php else: ?>
        <span class="badge text-bg-danger">NON TROVATO</span>
      <?php endif; ?>
    </td>
  </tr>
<?php endforeach; ?>
</tbody>


            <tfoot class="table-secondary text-dark">
              <tr>
                <th colspan="8" class="text-end">Totale rimborso squadra</th>
                <th colspan="2"><strong><?= number_format((int)$tot, 0, ',', '.') ?></strong></th>
              </tr>
            </tfoot>
          </table>
        </div>

        <div class="sticky-summary d-flex justify-content-between align-items-center">
          <div>
            Selezionati: <strong id="selCount">0</strong>
          </div>
          <div>
            Totale selezionati: <strong id="selTotal">0</strong>
          </div>
          <div class="d-none d-md-inline">
            <button class="btn btn-sm btn-outline-light me-2" id="btnAll">Seleziona tutti</button>
            <button class="btn btn-sm btn-outline-light" id="btnNone">Deseleziona</button>
          </div>
        </div>

      </div>
    </div>
  <?php endif; ?>

  <footer class="text-center text-secondary small pb-5">© <?= date('Y') ?> NegherLeague — stile e colori dal logo.</footer>
</div>

<script src="https://cdn.jsdelivr.net/npm/bootstrap@5.3.3/dist/js/bootstrap.bundle.min.js"></script>
<script>
(function(){
  const fmt = new Intl.NumberFormat('it-IT');
  const checks = Array.from(document.querySelectorAll('.row-check'));
  const selTotalEl = document.getElementById('selTotal');
  const selCountEl = document.getElementById('selCount');
  const checkAll = document.getElementById('checkAll');
  const btnAll = document.getElementById('btnAll');
  const btnNone = document.getElementById('btnNone');

  function recalc(){
    let tot = 0, cnt = 0;
    checks.forEach(ch => {
      if (ch.checked && !ch.disabled) {
        cnt++;
        tot += parseInt(ch.dataset.rimborso || '0', 10);
      }
    });
    selCountEl.textContent = fmt.format(cnt);
    selTotalEl.textContent = fmt.format(tot);
  }

  checks.forEach(ch => ch.addEventListener('change', recalc));
  if (checkAll){
    checkAll.addEventListener('change', () => {
      checks.forEach(ch => { if (!ch.disabled) ch.checked = checkAll.checked; });
      recalc();
    });
  }
  if (btnAll){
    btnAll.addEventListener('click', (e)=>{ e.preventDefault(); checks.forEach(ch=>{ if(!ch.disabled) ch.checked=true; }); if(checkAll) checkAll.checked=true; recalc(); });
  }
  if (btnNone){
    btnNone.addEventListener('click', (e)=>{ e.preventDefault(); checks.forEach(ch=>{ ch.checked=false; }); if(checkAll) checkAll.checked=false; recalc(); });
  }
  recalc();
})();
</script>
<!-- Player Modal -->
<div class="modal fade" id="playerModal" tabindex="-1" aria-hidden="true">
  <div class="modal-dialog modal-dialog-centered">
    <div class="modal-content bg-dark text-light">
      <div class="modal-header">
        <h5 class="modal-title" id="playerModalLabel">
  <?= htmlspecialchars(mb_strtoupper($selectedTeam ?: 'DETTAGLIO GIOCATORE','UTF-8')) ?>
</h5>
        <button type="button" class="btn-close btn-close-white" data-bs-dismiss="modal" aria-label="Chiudi"></button>
      </div>
      <div class="modal-body">
        <div class="d-flex align-items-center gap-3 mb-3">
          <img id="playerModalImg" class="rounded-3" style="width:140px;height:140px;object-fit:contain" alt="">
          <div>
            <div class="h5 mb-1" id="playerModalName"></div>
            <span class="badge text-dark" style="background:var(--brand-primary)" id="playerModalRole"></span>
          </div>
        </div>
        <div class="table-responsive px-0">
  <table id="tbl" class="table table-dark table-striped table-hover align-middle mb-0 w-100">
            <tbody>
              <tr><th>Squadra</th><td id="pm-squadra"></td></tr>
              <tr><th>Acquisto</th><td id="pm-acquisto"></td></tr>
              <tr><th>Q. attuale</th><td id="pm-qa"></td></tr>
              <tr><th>Q. iniziale</th><td id="pm-qi"></td></tr>
              <tr><th>Calcolo grezzo</th><td id="pm-calc"></td></tr>
              <tr><th>Rimborso</th><td id="pm-rimborso"></td></tr>
              <tr><th>Match</th><td id="pm-match"></td></tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</div>
<script>
(function(){
  const SEASON = '<?= CAMPIONCINO_PATH_SEASON ?>';
  const fmt = new Intl.NumberFormat('it-IT');
  let modalEl=null, bsModal=null;

  document.addEventListener('click', function(e){
    const a = e.target.closest('[data-open="player"], .player-open, .js-player-open');
    if (!a) return;
    e.preventDefault();

    if (!bsModal){
      modalEl = document.getElementById('playerModal');
      if (!modalEl) return;
      bsModal = new bootstrap.Modal(modalEl);
    }

    const team = a.dataset.team || '';           // 👈 fanta-squadra
    const name = a.dataset.player || '';
    const role = a.dataset.ruolo || '';
    const squadra = a.dataset.squadra || '—';
    const acquistoRaw = parseFloat(a.dataset.acquisto || 'NaN');
    const qaRaw = parseFloat(a.dataset.qatt || 'NaN');
    const qiRaw = parseFloat(a.dataset.qini || 'NaN');
    const calcRaw = parseFloat(a.dataset.calc || 'NaN');
    const rimborsoRaw = parseFloat(a.dataset.rimborso || 'NaN');

    // Titolo = NOME FANTA-SQUADRA (non il giocatore)
    document.getElementById('playerModalLabel').textContent = team || 'Dettaglio giocatore';

    // Immagine
    const id = a.dataset.id || '';
    const imgEl = document.getElementById('playerModalImg');
    if (id) {
      const card = `https://content.fantacalcio.it/web/campioncini/${SEASON}/card/${id}.png?v=342`;
      const small = `https://content.fantacalcio.it/web/campioncini/${SEASON}/small/${id}.png?v=342`;
      imgEl.onerror = ()=>{ imgEl.onerror=null; imgEl.src = small; };
      imgEl.src = card; imgEl.alt = name;
    } else {
      const img = a.querySelector('img');
      imgEl.onerror = null; imgEl.src = img ? img.src : ''; imgEl.alt = name;
    }

    // Dati base
    document.getElementById('playerModalName').textContent = name || '—';
    document.getElementById('playerModalRole').textContent = role || '—';
    document.getElementById('pm-squadra').textContent = squadra;
    document.getElementById('pm-acquisto').textContent = isNaN(acquistoRaw) ? '—' : fmt.format(acquistoRaw);
    document.getElementById('pm-qa').textContent = isNaN(qaRaw) ? '—' : fmt.format(qaRaw);
    document.getElementById('pm-qi').textContent = isNaN(qiRaw) ? '—' : fmt.format(qiRaw);
    document.getElementById('pm-calc').textContent = isNaN(calcRaw) ? '—' : fmt.format(calcRaw);

    // Rimborso con colori come nel PHP originale
    const rimCell = document.getElementById('pm-rimborso');
    rimCell.classList.remove('text-success','text-danger','text-white','text-muted','num');
    if (isNaN(rimborsoRaw)) {
      rimCell.textContent = '—';
      rimCell.classList.add('text-muted','num');
    } else {
      rimCell.textContent = fmt.format(rimborsoRaw);
      let cls = 'text-white';
      if (!isNaN(acquistoRaw)) {
        if (rimborsoRaw < acquistoRaw) cls = 'text-danger';
        else if (rimborsoRaw > acquistoRaw) cls = 'text-success';
      }
      rimCell.classList.add(cls,'num');
    }

    document.getElementById('pm-match').textContent = a.dataset.match || '';
    bsModal.show();
  });
})();
</script>
</body>
</html>
