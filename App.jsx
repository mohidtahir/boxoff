import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

const YEAR = new Date().getFullYear();
const CACHE_KEY = 'box-office-records-cache-v4';
const WIKI_API = 'https://en.wikipedia.org/w/api.php';
const BOM_BASE = 'https://www.boxofficemojo.com';
const WEEKLY_INDEX_URL = `${BOM_BASE}/weekly/`;
const CORS_PROXIES = [
  (url) => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  (url) => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
  (url) => `https://api.codetabs.com/v1/proxy?quest=${encodeURIComponent(url)}`,
];

const PAGES = {
  current: `${YEAR}_in_film`,
  alltime: 'List_of_highest-grossing_films',
};

const SOURCE_URLS = {
  current: `https://en.wikipedia.org/wiki/${PAGES.current}`,
  alltime: `https://en.wikipedia.org/wiki/${PAGES.alltime}`,
};

const EMPTY_DATA = { weekly: [], current: [], alltime: [] };

function cleanText(value) {
  return String(value || '')
    .replace(/\[[^\]]*\]/g, '')
    .replace(/[†‡]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function parseGross(value) {
  const text = String(value || '').toLowerCase().replace(/,/g, '');
  const match = text.match(/\d+(?:\.\d+)?/);
  if (!match) return 0;

  let amount = Number(match[0]);
  if (/\btrillion\b/.test(text)) amount *= 1e12;
  else if (/\bbillion\b/.test(text)) amount *= 1e9;
  else if (/\bmillion\b/.test(text)) amount *= 1e6;
  return Number.isFinite(amount) ? amount : 0;
}

function getBoxOfficeMojoWeekUrl(weekPath) {
  if (!weekPath) return WEEKLY_INDEX_URL;
  if (/^https?:\/\//i.test(weekPath)) return weekPath;
  return new URL(weekPath, BOM_BASE).href;
}

function getWikiUrl(title) {
  return `https://en.wikipedia.org/wiki/${encodeURIComponent(title.trim().replace(/\s+/g, '_'))}`;
}

async function fetchProxiedHtml(target, label = 'box-office chart') {
  const controllers = [];
  const attempts = CORS_PROXIES.map(async (buildProxyUrl) => {
    const controller = new AbortController();
    controllers.push(controller);
    const timeout = window.setTimeout(() => controller.abort(), 4500);
    try {
      const response = await fetch(buildProxyUrl(target), {
        signal: controller.signal,
        cache: 'no-cache',
      });
      if (!response.ok) throw new Error(`${label} request failed (HTTP ${response.status}).`);
      const html = await response.text();
      if (!html || !/<table/i.test(html) || /cloudflare|access denied|robot check/i.test(html.slice(0, 1800))) {
        throw new Error(`The ${label} response was not readable.`);
      }
      return html;
    } finally {
      window.clearTimeout(timeout);
    }
  });

  try {
    return await Promise.any(attempts);
  } catch {
    throw new Error(`Could not reach Box Office Mojo through the available public proxies.`);
  } finally {
    controllers.forEach((controller) => controller.abort());
  }
}

async function fetchWeekIndexHtml() {
  return fetchProxiedHtml(WEEKLY_INDEX_URL, 'weekly index');
}

async function fetchWeekHtml(weekPath) {
  return fetchProxiedHtml(getBoxOfficeMojoWeekUrl(weekPath), 'weekly chart');
}

function parseWeeklyIndex(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const weeks = new Map();

  for (const row of doc.querySelectorAll('table tr')) {
    const cells = Array.from(row.cells || []);
    if (cells.length < 2) continue;

    const links = Array.from(row.querySelectorAll('a[href]'));
    const weekLink = links.find((link) => /\/weekly\/\d{4}W\d+\/?(?:[?#]|$)/.test(link.getAttribute('href') || ''));
    if (!weekLink) continue;

    const href = new URL(weekLink.getAttribute('href'), BOM_BASE);
    const match = href.pathname.match(/\/weekly\/(\d{4})W(\d+)\/?/);
    if (!match) continue;

    const label = cleanText(weekLink.textContent);
    if (!label) continue;
    const path = `${href.pathname.replace(/\/+$/, '')}/`;
    const year = Number(match[1]);
    const weekNumber = Number(match[2]);
    weeks.set(path, {
      path,
      id: `${match[1]}W${String(weekNumber).padStart(2, '0')}`,
      label: `${label}, ${year}`,
      year,
      weekNumber,
      sortKey: year * 100 + weekNumber,
    });
  }

  const result = Array.from(weeks.values()).sort((a, b) => b.sortKey - a.sortKey);
  if (!result.length) throw new Error('Could not find published weeks on Box Office Mojo.');
  return result;
}

function parseWeekMovies(html, week) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const tables = Array.from(doc.querySelectorAll('table'));
  const movies = [];
  let chartDate = week?.label || 'Selected week';

  const dateHeading = Array.from(doc.querySelectorAll('h4, h3, h2')).map((node) => cleanText(node.textContent))
    .find((text) => /\b20\d{2}\b/.test(text) && /[A-Za-z]{3,}\s+\d{1,2}/.test(text));
  if (dateHeading) chartDate = dateHeading;

  for (const table of tables) {
    const rows = Array.from(table.querySelectorAll('tr'));
    const headerIndex = rows.findIndex((row) => {
      const labels = Array.from(row.cells || []).map((cell) => cleanText(cell.textContent).toLowerCase());
      return labels.some((label) => /^rank$/.test(label)) &&
        labels.some((label) => /^release$|^title$/.test(label)) &&
        labels.some((label) => /^gross$/.test(label));
    });
    if (headerIndex < 0) continue;

    const headers = Array.from(rows[headerIndex].cells || []).map((cell) => cleanText(cell.textContent).toLowerCase());
    const rankIndex = headers.findIndex((label) => /^rank$/.test(label));
    const titleIndex = headers.findIndex((label) => /^release$|^title$/.test(label));
    const grossIndex = headers.findIndex((label) => /^gross$/.test(label));
    if (titleIndex < 0 || grossIndex < 0) continue;

    for (const row of rows.slice(headerIndex + 1)) {
      const cells = Array.from(row.cells || []);
      if (cells.length <= Math.max(titleIndex, grossIndex)) continue;

      const titleCell = cells[titleIndex];
      const titleAnchor = titleCell?.querySelector('a[href]');
      const title = cleanText(titleAnchor?.textContent || titleCell?.textContent);
      const gross = cleanText(cells[grossIndex]?.textContent);
      const grossValue = parseGross(gross);
      if (!title || !gross || !grossValue || /^(reporting|total|rank|release|title)$/i.test(title)) continue;

      const href = titleAnchor?.getAttribute('href');
      const url = href ? new URL(href, BOM_BASE).href : getBoxOfficeMojoWeekUrl(week?.path);
      const rank = Number.parseInt(cleanText(cells[rankIndex]?.textContent), 10);
      movies.push({ rank: Number.isFinite(rank) && rank > 0 ? rank : 999, title, gross, date: chartDate, url });
    }
    if (movies.length) break;
  }

  const fullWeek = movies
    .sort((a, b) => a.rank - b.rank || parseGross(b.gross) - parseGross(a.gross))
    .map((movie, index) => ({ ...movie, rank: index + 1 }));

  if (!fullWeek.length) {
    throw new Error('No film grosses were found on this Box Office Mojo weekly chart. Open the source chart or try another week.');
  }
  return fullWeek;
}

function formatUpdatedAt(value) {
  if (!value) return 'Not synced yet';
  return value.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

async function fetchWikiPage(page) {
  const params = new URLSearchParams({
    action: 'parse',
    page,
    prop: 'text',
    format: 'json',
    origin: '*',
  });

  const response = await fetch(`${WIKI_API}?${params}`);
  if (!response.ok) throw new Error(`Wikipedia returned HTTP ${response.status}`);
  const result = await response.json();
  const html = result?.parse?.text?.['*'];
  if (!html) throw new Error(`Could not retrieve Wikipedia page: ${page}`);
  return html;
}

// Expand rowspan/colspan cells into a grid so Wikipedia's merged headers stay aligned.
function buildTableGrid(table) {
  const grid = [];

  Array.from(table.rows).forEach((row, rowIndex) => {
    grid[rowIndex] ||= [];
    let colIndex = 0;

    Array.from(row.cells).forEach((cell) => {
      while (grid[rowIndex][colIndex]) colIndex++;
      const rowSpan = Math.max(1, cell.rowSpan || 1);
      const colSpan = Math.max(1, cell.colSpan || 1);

      for (let r = rowIndex; r < rowIndex + rowSpan; r++) {
        grid[r] ||= [];
        for (let c = colIndex; c < colIndex + colSpan; c++) grid[r][c] = cell;
      }
      colIndex += colSpan;
    });
  });

  return grid;
}

function findWikiChart(html) {
  const doc = new DOMParser().parseFromString(html, 'text/html');
  const candidates = [];

  for (const table of doc.querySelectorAll('table.wikitable')) {
    const grid = buildTableGrid(table);

    for (let rowIndex = 0; rowIndex < grid.length; rowIndex++) {
      const headers = grid[rowIndex].map((cell) => cleanText(cell?.textContent).toLowerCase());
      const titleIndex = headers.findIndex((label) => /\b(title|film|films|movie)\b/.test(label));
      const grossIndex = headers.findIndex((label) => /\bgross\b|box office/.test(label));
      const rankIndex = headers.findIndex((label) => /^(rank|no\.?|#)$/.test(label));

      if (titleIndex < 0 || grossIndex < 0) continue;

      let score = 1;
      if (/worldwide gross/.test(headers[grossIndex])) score += 30;
      if (rankIndex >= 0) score += 4;
      if (/\b(title|film|films|movie)\b/.test(headers[titleIndex])) score += 2;

      candidates.push({ grid, headerIndex: rowIndex, titleIndex, grossIndex, rankIndex, score });
      break;
    }
  }

  candidates.sort((a, b) => b.score - a.score);
  if (!candidates.length) throw new Error('Could not find a film-gross table on Wikipedia.');
  return candidates[0];
}

function parseRankedMovies(html) {
  const chart = findWikiChart(html);
  const movies = chart.grid
    .slice(chart.headerIndex + 1)
    .map((row, index) => {
      const title = cleanText(row[chart.titleIndex]?.textContent);
      const gross = cleanText(row[chart.grossIndex]?.textContent);
      const rawRank = chart.rankIndex >= 0 ? cleanText(row[chart.rankIndex]?.textContent) : '';
      return { rank: Number.parseInt(rawRank, 10) || index + 1, title, gross, date: '', url: getWikiUrl(title) };
    })
    .filter((movie) => movie.title && movie.gross && parseGross(movie.gross) > 0)
    .sort((a, b) => a.rank - b.rank)
    .slice(0, 10);

  if (!movies.length) throw new Error('No ranked films were found on Wikipedia.');
  return movies;
}

function Icon({ name, size = 16 }) {
  const common = {
    width: size,
    height: size,
    viewBox: '0 0 24 24',
    fill: 'none',
    stroke: 'currentColor',
    strokeWidth: 1.7,
    strokeLinecap: 'round',
    strokeLinejoin: 'round',
    'aria-hidden': true,
  };

  const paths = {
    arrow: <><path d="M5 12h13" /><path d="m12 5 7 7-7 7" /></>,
    refresh: <><path d="M20 7v5h-5" /><path d="M4.9 9A7.5 7.5 0 0 1 18 6l2 6" /><path d="M4 17v-5h5" /><path d="M19.1 15A7.5 7.5 0 0 1 6 18l-2-6" /></>,
    search: <><circle cx="10.8" cy="10.8" r="6.8" /><path d="m16 16 4.2 4.2" /></>,
  };

  return <svg {...common}>{paths[name] || paths.arrow}</svg>;
}

function App() {
  const [activeTab, setActiveTab] = useState('weekly');
  const [selectedWeek, setSelectedWeek] = useState('');
  const [weekOptions, setWeekOptions] = useState([]);
  const [data, setData] = useState(EMPTY_DATA);
  const [loadingTabs, setLoadingTabs] = useState({ weekly: true, current: false, alltime: false });
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const [lastUpdated, setLastUpdated] = useState(null);
  const [search, setSearch] = useState('');
  const [sortBy, setSortBy] = useState('rank');
  const [dataNotice, setDataNotice] = useState('');

  const selectedWeekRef = useRef('');
  const weekOptionsRef = useRef([]);
  const dataRef = useRef(EMPTY_DATA);
  const weeklyRequestIdRef = useRef(0);
  const wikiLoadingRef = useRef({ current: false, alltime: false });
  const lastWeeklyFetchedRef = useRef(0);
  const lastWeeklyAttemptRef = useRef(0);

  const commitData = useCallback((nextData) => {
    dataRef.current = nextData;
    setData(nextData);
  }, []);

  const commitWeekOptions = useCallback((weeks) => {
    weekOptionsRef.current = weeks;
    setWeekOptions(weeks);
  }, []);

  const saveCache = useCallback((nextData, timestamp, weekPath) => {
    try {
      window.localStorage.setItem(CACHE_KEY, JSON.stringify({
        data: nextData,
        updatedAt: timestamp.toISOString(),
        weekPath,
        weekOptions: weekOptionsRef.current,
        weeklyUpdatedAt: lastWeeklyFetchedRef.current
          ? new Date(lastWeeklyFetchedRef.current).toISOString()
          : null,
      }));
    } catch {
      // Cache storage is optional; live data remains usable without it.
    }
  }, []);

  const loadSelectedWeek = useCallback(async (weekPath) => {
    if (!weekPath) return;
    const requestId = ++weeklyRequestIdRef.current;
    const previousPath = selectedWeekRef.current;
    selectedWeekRef.current = weekPath;
    setSelectedWeek(weekPath);
    setLoadingTabs((previous) => ({ ...previous, weekly: true }));
    setRefreshing(true);
    setError('');
    setDataNotice('');

    if (previousPath !== weekPath) commitData({ ...dataRef.current, weekly: [] });

    try {
      const week = weekOptionsRef.current.find((item) => item.path === weekPath) || { path: weekPath, label: 'Selected week' };
      const html = await fetchWeekHtml(weekPath);
      const movies = parseWeekMovies(html, week);
      if (requestId !== weeklyRequestIdRef.current || selectedWeekRef.current !== weekPath) return;

      const nextData = { ...dataRef.current, weekly: movies };
      commitData(nextData);
      const timestamp = new Date();
      setLastUpdated(timestamp);
      lastWeeklyFetchedRef.current = timestamp.getTime();
      lastWeeklyAttemptRef.current = timestamp.getTime();
      saveCache(nextData, timestamp, weekPath);
    } catch (err) {
      if (requestId === weeklyRequestIdRef.current && selectedWeekRef.current === weekPath) {
        setError(err?.message || 'Could not load this weekly chart.');
        setDataNotice('You can open the original Box Office Mojo chart to verify the figures.');
      }
    } finally {
      if (requestId === weeklyRequestIdRef.current) {
        setLoadingTabs((previous) => ({ ...previous, weekly: false }));
        setRefreshing(false);
      }
    }
  }, [commitData, saveCache]);

  const loadLatestAvailableWeek = useCallback(async () => {
    const requestId = ++weeklyRequestIdRef.current;
    lastWeeklyAttemptRef.current = Date.now();
    setLoadingTabs((previous) => ({ ...previous, weekly: true }));
    setRefreshing(true);
    setError('');
    setDataNotice('');

    try {
      // The index itself identifies the newest published chart, so no guessed dates
      // or failed requests for unpublished weeks are needed.
      const indexHtml = await fetchWeekIndexHtml();
      const weeks = parseWeeklyIndex(indexHtml);
      if (requestId !== weeklyRequestIdRef.current) return;
      commitWeekOptions(weeks);

      const latest = weeks[0];
      const previousPath = selectedWeekRef.current;
      selectedWeekRef.current = latest.path;
      setSelectedWeek(latest.path);

      const cacheIsLatestAndFresh = previousPath === latest.path && dataRef.current.weekly.length > 0 &&
        lastWeeklyFetchedRef.current > 0 && Date.now() - lastWeeklyFetchedRef.current < 6 * 60 * 60 * 1000;
      if (cacheIsLatestAndFresh) return;

      if (previousPath !== latest.path) commitData({ ...dataRef.current, weekly: [] });
      const detailHtml = await fetchWeekHtml(latest.path);
      const movies = parseWeekMovies(detailHtml, latest);
      if (requestId !== weeklyRequestIdRef.current || selectedWeekRef.current !== latest.path) return;

      const nextData = { ...dataRef.current, weekly: movies };
      commitData(nextData);
      const timestamp = new Date();
      setLastUpdated(timestamp);
      lastWeeklyFetchedRef.current = timestamp.getTime();
      lastWeeklyAttemptRef.current = timestamp.getTime();
      saveCache(nextData, timestamp, latest.path);
    } catch (err) {
      if (requestId === weeklyRequestIdRef.current) {
        setError(err?.message || 'Could not load the latest Box Office Mojo weekly chart.');
        setDataNotice('Open Box Office Mojo directly or retry if the public browser proxy is unavailable.');
      }
    } finally {
      if (requestId === weeklyRequestIdRef.current) {
        setLoadingTabs((previous) => ({ ...previous, weekly: false }));
        setRefreshing(false);
      }
    }
  }, [commitData, commitWeekOptions, saveCache]);

  const loadWikiTab = useCallback(async (tab, force = false) => {
    if (tab !== 'current' && tab !== 'alltime') return;
    if (!force && dataRef.current[tab]?.length) return;
    if (wikiLoadingRef.current[tab]) return;

    wikiLoadingRef.current[tab] = true;
    setLoadingTabs((previous) => ({ ...previous, [tab]: true }));
    setRefreshing(true);
    setError('');
    setDataNotice('');
    try {
      const page = tab === 'current' ? PAGES.current : PAGES.alltime;
      const movies = await fetchWikiPage(page).then(parseRankedMovies);
      const nextData = { ...dataRef.current, [tab]: movies };
      commitData(nextData);
      const timestamp = new Date();
      setLastUpdated(timestamp);
      saveCache(nextData, timestamp, selectedWeekRef.current);
    } catch (err) {
      setError(err?.message || 'Could not load this chart.');
      setDataNotice('Check your connection or open the source page directly.');
    } finally {
      wikiLoadingRef.current[tab] = false;
      setLoadingTabs((previous) => ({ ...previous, [tab]: false }));
      setRefreshing(false);
    }
  }, [commitData, saveCache]);

  useEffect(() => {
    try {
      const cached = window.localStorage.getItem(CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        const cachedData = { ...EMPTY_DATA, ...(parsed?.data || {}) };
        const cachedPath = parsed?.weekPath || '';
        const weeks = Array.isArray(parsed?.weekOptions) ? parsed.weekOptions : [];
        commitData(cachedData);
        if (weeks.length) commitWeekOptions(weeks);
        if (cachedPath) {
          selectedWeekRef.current = cachedPath;
          setSelectedWeek(cachedPath);
        }
        if (parsed?.updatedAt) {
          const timestamp = new Date(parsed.updatedAt);
          if (!Number.isNaN(timestamp.getTime())) setLastUpdated(timestamp);
        }
        const weeklyTimestamp = new Date(parsed?.weeklyUpdatedAt || 0).getTime();
        if (Number.isFinite(weeklyTimestamp)) lastWeeklyFetchedRef.current = weeklyTimestamp;
      }
    } catch {
      // Ignore damaged or unavailable browser cache.
    }

    loadLatestAvailableWeek();

    const interval = window.setInterval(() => {
      if (Date.now() - lastWeeklyAttemptRef.current >= 12 * 60 * 60 * 1000) loadLatestAvailableWeek();
    }, 60 * 60 * 1000);
    const onVisible = () => {
      if (document.visibilityState === 'visible' && Date.now() - lastWeeklyAttemptRef.current >= 6 * 60 * 60 * 1000) {
        loadLatestAvailableWeek();
      }
    };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [commitData, commitWeekOptions, loadLatestAvailableWeek]);

  const tabs = [
    { id: 'weekly', title: 'Week', note: 'Full weekly chart of reported films' },
    { id: 'current', title: `${YEAR} releases`, note: 'Films from the current year' },
    { id: 'alltime', title: 'All-time worldwide', note: 'Highest reported worldwide grosses' },
  ];

  const currentMovies = data[activeTab] || [];
  const featured = currentMovies[0];
  const isWeekly = activeTab === 'weekly';

  const filteredMovies = useMemo(() => {
    const query = search.trim().toLowerCase();
    const result = currentMovies.filter((movie) => movie.title.toLowerCase().includes(query));
    if (sortBy === 'gross') return [...result].sort((a, b) => parseGross(b.gross) - parseGross(a.gross));
    return [...result].sort((a, b) => a.rank - b.rank);
  }, [currentMovies, search, sortBy]);

  const totalShownGross = currentMovies.reduce((sum, movie) => sum + parseGross(movie.gross), 0);
  const selectedWeekInfo = weekOptions.find((week) => week.path === selectedWeek);
  const currentWeekLabel = selectedWeekInfo?.label || currentMovies[0]?.date || 'Latest available week';
  const sourceUrl = isWeekly ? getBoxOfficeMojoWeekUrl(selectedWeek) : SOURCE_URLS[activeTab];
  const heading = {
    weekly: 'The weekly chart',
    current: `The ${YEAR} chart`,
    alltime: 'The worldwide all-time chart',
  }[activeTab];
  const subheading = {
    weekly: `All reported domestic film grosses for ${currentWeekLabel}.`,
    current: `The leading films listed on Wikipedia’s ${YEAR} film chart.`,
    alltime: 'Worldwide grosses as listed by Wikipedia; reported totals can be revised.',
  }[activeTab];

  return (
    <div className="min-h-screen bg-[#080b0b] text-[#edf2ef] selection:bg-[#65d6bd] selection:text-[#07100e]">
      <div className="mx-auto max-w-[1240px] px-5 pb-10 sm:px-8 lg:px-10">
        <header className="flex flex-wrap items-center justify-between gap-5 border-b border-[#29423c] py-5">
          <a href="#top" className="flex items-center gap-3 text-inherit no-underline" aria-label="Box Office Records home">
            <span className="flex h-10 w-10 items-center justify-center border border-[#65d6bd] font-serif text-sm font-bold text-[#65d6bd]">BO</span>
            <span>
              <span className="block text-xs font-bold uppercase tracking-[0.2em]">Box Office Records</span>
              <span className="mt-1 block text-[10px] uppercase tracking-[0.15em] text-[#84948e]">Film earnings, reported plainly</span>
            </span>
          </a>

          <nav className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-[#aab8b2]" aria-label="Main navigation">
            <a href="#rankings" className="transition hover:text-[#65d6bd]">Charts</a>
            <a href="#about-data" className="transition hover:text-[#65d6bd]">Data notes</a>
            <a href={sourceUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[#65d6bd] transition hover:text-white">
              Open source <Icon name="arrow" size={13} />
            </a>
            <button
              onClick={() => activeTab === 'weekly' ? (selectedWeekRef.current ? loadSelectedWeek(selectedWeekRef.current) : loadLatestAvailableWeek()) : loadWikiTab(activeTab, true)}
              disabled={refreshing}
              className="inline-flex items-center gap-2 border border-[#3b5c53] px-3 py-2 text-xs font-semibold text-[#d6e5df] transition hover:border-[#65d6bd] hover:text-[#65d6bd] disabled:cursor-wait disabled:opacity-50"
            >
              <span className={refreshing ? 'animate-spin' : ''}><Icon name="refresh" size={14} /></span>
              {refreshing ? 'Updating' : 'Refresh'}
            </button>
          </nav>
        </header>

        <main>
          <section id="top" className="grid gap-8 border-b border-[#29423c] py-8 sm:py-10 lg:grid-cols-[1.15fr_0.85fr] lg:gap-12 lg:py-11">
            <div className="max-w-2xl">
              <p className="mb-4 text-[10px] font-bold uppercase tracking-[0.22em] text-[#65d6bd]">Domestic and worldwide box office</p>
              <h1 className="max-w-xl font-serif text-[2.65rem] font-medium leading-[0.98] tracking-[-0.045em] text-[#f0f2ed] sm:text-[3.45rem]">
                Box-office charts,<br />week by week.
              </h1>
              <p className="mt-5 max-w-lg text-sm leading-6 text-[#a4b0aa] sm:text-[15px]">
                Weekly box-office charts, this year’s leading releases, and the highest-grossing films worldwide — with each chart linked to its source.
              </p>
              <a href="#rankings" className="mt-6 inline-flex items-center gap-2 border-b border-[#65d6bd] pb-1.5 text-xs font-bold uppercase tracking-[0.13em] text-[#65d6bd] transition hover:text-white">
                Browse the charts <Icon name="arrow" size={14} />
              </a>
            </div>

            <aside className="border-l-2 border-[#65d6bd] py-1 pl-5 sm:pl-7" aria-label="Featured record">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <p className="text-[10px] font-bold uppercase tracking-[0.19em] text-[#93a29b]">Top reported film</p>
                <span className="text-[10px] uppercase tracking-[0.13em] text-[#65d6bd]">
                  {isWeekly ? 'Selected week' : activeTab === 'current' ? `${YEAR} chart` : 'All-time'}
                </span>
              </div>
              <p className="mt-5 font-serif text-2xl leading-tight tracking-[-0.02em] sm:text-[1.8rem]">
                {featured?.title || (loadingTabs[activeTab] ? 'Loading chart…' : 'No record available')}
              </p>
              <p className="mt-3 text-[10px] font-bold uppercase tracking-[0.16em] text-[#81928b]">
                {isWeekly ? 'Weekly gross' : 'Reported gross'}
              </p>
              <p className="mt-1 break-words text-2xl font-semibold tracking-[-0.04em] text-[#65d6bd] sm:text-[1.9rem]">
                {featured?.gross || '—'}
              </p>
              <div className="mt-5 flex flex-wrap items-center gap-x-4 gap-y-2 text-xs text-[#a4b0aa]">
                {featured?.url && (
                  <a href={featured.url} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1.5 text-[#d6e5df] underline decoration-[#3b5c53] underline-offset-4 transition hover:text-[#65d6bd]">
                    Film details <Icon name="arrow" size={12} />
                  </a>
                )}
                {isWeekly && <span>{currentWeekLabel}</span>}
              </div>
            </aside>
          </section>

          <section className="grid grid-cols-1 border-b border-[#29423c] sm:grid-cols-3" aria-label="Chart summary">
            <div className="border-b border-[#29423c] py-4 pr-5 sm:border-b-0 sm:border-r sm:py-5">
              <p className="text-[10px] uppercase tracking-[0.15em] text-[#81928b]">Films listed</p>
              <p className="mt-1 font-serif text-2xl text-[#f0f2ed]">{currentMovies.length ? String(currentMovies.length).padStart(2, '0') : '—'}</p>
            </div>
            <div className="border-b border-[#29423c] py-4 sm:px-5 sm:border-b-0 sm:border-r sm:py-5">
              <p className="text-[10px] uppercase tracking-[0.15em] text-[#81928b]">Combined gross shown</p>
              <p className="mt-1 text-xl font-semibold tracking-[-0.035em] text-[#f0f2ed]">{currentMovies.length ? `$${totalShownGross.toLocaleString('en-US', { maximumFractionDigits: 0 })}` : '—'}</p>
            </div>
            <div className="py-4 sm:pl-5 sm:py-5">
              <p className="text-[10px] uppercase tracking-[0.15em] text-[#81928b]">Last successful update</p>
              <p className="mt-2 text-sm font-medium text-[#d5dfda]">{formatUpdatedAt(lastUpdated)}</p>
            </div>
          </section>

          <section id="rankings" className="scroll-mt-5 pt-8 sm:pt-10">
            <div className="flex flex-col justify-between gap-5 md:flex-row md:items-end">
              <div>
                <p className="mb-3 text-[10px] font-bold uppercase tracking-[0.2em] text-[#65d6bd]">The rankings</p>
                <h2 className="font-serif text-3xl font-medium tracking-[-0.035em] sm:text-[2.5rem]">{heading}</h2>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[#96a49d]">{subheading}</p>
              </div>
              <p className="text-xs text-[#81928b]">
                Source:{' '}
                <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-[#65d6bd] underline decoration-[#3b5c53] underline-offset-4 hover:text-white">
                  {isWeekly ? 'Box Office Mojo' : 'Wikipedia'} ↗
                </a>
              </p>
            </div>

            <div className="mt-6 border-y border-[#29423c]">
              <div className="grid grid-cols-1 sm:grid-cols-3">
                {tabs.map((tab, index) => {
                  const selected = activeTab === tab.id;
                  return (
                    <button
                      key={tab.id}
                      onClick={() => {
                        setActiveTab(tab.id);
                        setSearch('');
                        setSortBy('rank');
                        setError('');
                        setDataNotice('');
                        if (tab.id === 'weekly' && (!dataRef.current.weekly.length || !selectedWeekRef.current)) {
                          loadLatestAvailableWeek();
                        } else if (tab.id !== 'weekly' && !dataRef.current[tab.id]?.length) {
                          loadWikiTab(tab.id);
                        }
                      }}
                      aria-pressed={selected}
                      className={`relative min-h-[76px] border-b border-[#29423c] px-3 py-4 text-left transition last:border-b-0 sm:border-b-0 sm:px-4 ${index > 0 ? 'sm:border-l' : ''} ${selected ? 'bg-[#0d1714]' : 'hover:bg-[#0a100e]'}`}
                    >
                      {selected && <span className="absolute inset-x-0 top-0 h-[2px] bg-[#65d6bd]" />}
                      <span className={`block text-sm font-semibold ${selected ? 'text-[#65d6bd]' : 'text-[#d4ddd8]'}`}>{tab.title}</span>
                      <span className="mt-1 block text-xs leading-5 text-[#81928b]">{tab.note}</span>
                    </button>
                  );
                })}
              </div>
            </div>

            <div className="flex flex-col gap-3 border-b border-[#29423c] py-4 lg:flex-row lg:items-center">
              {isWeekly && (
                <label className="flex min-h-11 items-center gap-3 border border-[#29423c] px-3.5 lg:min-w-[250px]">
                  <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-[#81928b]">Week</span>
                  <select
                    value={selectedWeek}
                    onChange={(event) => loadSelectedWeek(event.target.value)}
                    className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[#edf2ef] outline-none"
                    aria-label="Choose a week"
                  >
                    {weekOptions.map((week) => (
                      <option key={week.path} value={week.path} className="bg-[#080b0b] text-[#edf2ef]">{week.label}</option>
                    ))}
                  </select>
                </label>
              )}

              <label className="flex min-h-11 flex-1 items-center gap-3 border border-[#29423c] px-3.5 focus-within:border-[#65d6bd]">
                <Icon name="search" size={16} />
                <input
                  value={search}
                  onChange={(event) => setSearch(event.target.value)}
                  placeholder="Find a film in this chart"
                  aria-label="Search films"
                  className="w-full bg-transparent py-2 text-sm outline-none placeholder:text-[#65766f]"
                />
                {search && <button onClick={() => setSearch('')} aria-label="Clear search" className="px-1 text-lg leading-none text-[#81928b] hover:text-white">×</button>}
              </label>

              <label className="flex min-h-11 items-center gap-3 border border-[#29423c] px-3.5 lg:min-w-[210px]">
                <span className="shrink-0 text-[10px] font-bold uppercase tracking-[0.12em] text-[#81928b]">Sort</span>
                <select
                  value={sortBy}
                  onChange={(event) => setSortBy(event.target.value)}
                  aria-label="Sort films"
                  className="min-w-0 flex-1 bg-transparent py-2 text-sm text-[#edf2ef] outline-none"
                >
                  <option value="rank" className="bg-[#080b0b]">Chart rank</option>
                  <option value="gross" className="bg-[#080b0b]">Gross: high to low</option>
                </select>
              </label>
            </div>

            <div className="flex items-center justify-between gap-3 py-3 text-xs text-[#81928b]">
              <span>{filteredMovies.length} {filteredMovies.length === 1 ? 'film' : 'films'} shown</span>
              <span>{isWeekly ? 'Full-week domestic gross · USD' : 'Reported gross · USD'}</span>
            </div>

            {loadingTabs[activeTab] && !currentMovies.length ? (
              <div className="border-y border-[#29423c] py-12 text-center">
                <div className="mx-auto mb-4 h-6 w-6 animate-spin border-2 border-[#29423c] border-t-[#65d6bd]" />
                <p className="font-serif text-xl">Loading the chart</p>
                <p className="mt-2 text-sm text-[#81928b]">Fetching published box-office figures.</p>
              </div>
            ) : filteredMovies.length ? (
              <ol className="border-t border-[#29423c]">
                {filteredMovies.map((movie, index) => {
                  const filmUrl = movie.url || getWikiUrl(movie.title);
                  return (
                    <li key={`${activeTab}-${movie.title}-${movie.rank}`} className="grid grid-cols-[38px_minmax(0,1fr)] items-start gap-x-3 border-b border-[#243a34] py-4 transition hover:bg-[#0b1210] sm:grid-cols-[48px_minmax(0,1fr)_minmax(145px,0.42fr)] sm:items-center sm:gap-x-5 sm:py-[18px]">
                      <span className={`pt-0.5 font-serif text-xl ${movie.rank <= 3 ? 'text-[#65d6bd]' : 'text-[#71827b]'} sm:text-2xl`}>
                        {String(index + 1).padStart(2, '0')}
                      </span>
                      <div className="min-w-0">
                        <a href={filmUrl} target="_blank" rel="noreferrer" className="break-words text-sm font-semibold leading-6 text-[#edf2ef] transition hover:text-[#65d6bd] sm:text-base">
                          {movie.title}
                        </a>
                        <p className="mt-1 text-[10px] uppercase tracking-[0.12em] text-[#71827b]">
                          {isWeekly ? (movie.date || currentWeekLabel) : activeTab === 'current' ? `${YEAR} release chart` : 'Worldwide theatrical gross'}
                        </p>
                      </div>
                      <div className="col-span-2 mt-3 flex items-center justify-between gap-3 border-t border-[#20332e] pt-3 sm:col-span-1 sm:mt-0 sm:block sm:border-0 sm:pt-0 sm:text-right">
                        <span className="text-[10px] font-bold uppercase tracking-[0.12em] text-[#71827b] sm:hidden">Gross</span>
                        <span className="break-words text-sm font-semibold tabular-nums text-[#65d6bd] sm:text-base">{movie.gross}</span>
                      </div>
                    </li>
                  );
                })}
              </ol>
            ) : (
              <div className="border-y border-[#29423c] px-5 py-12 text-center">
                <p className="font-serif text-xl">{error ? 'This chart is unavailable' : 'No matching films'}</p>
                <p className="mt-2 text-sm leading-6 text-[#81928b]">
                  {error ? 'Try refreshing, choosing a different week, or opening the source chart.' : 'Try another title or clear your search.'}
                </p>
                {error && (
                  <button onClick={() => activeTab === 'weekly' ? (selectedWeekRef.current ? loadSelectedWeek(selectedWeekRef.current) : loadLatestAvailableWeek()) : loadWikiTab(activeTab, true)} className="mt-5 border border-[#65d6bd] px-4 py-2.5 text-xs font-bold uppercase tracking-[0.12em] text-[#65d6bd] transition hover:bg-[#65d6bd] hover:text-[#07100e]">
                    Try again
                  </button>
                )}
              </div>
            )}

            {error && currentMovies.length > 0 && (
              <p role="status" className="mt-4 border-l-2 border-[#d7b46a] bg-[#13120d] px-4 py-3 text-xs leading-5 text-[#d7c9a8]">{error}</p>
            )}
            {dataNotice && <p className="mt-3 text-xs leading-5 text-[#81928b]">{dataNotice}</p>}
          </section>
        </main>

        <footer id="about-data" className="mt-12 border-t border-[#29423c] pt-6">
          <div className="flex flex-col gap-5 sm:flex-row sm:items-start sm:justify-between">
            <div className="max-w-2xl">
              <p className="text-xs font-bold uppercase tracking-[0.18em] text-[#dbe5df]">About these figures</p>
              <p className="mt-3 text-xs leading-6 text-[#81928b]">
                The weekly chart lists every film reported on Box Office Mojo’s domestic weekly chart, with each film’s gross for the full displayed week (not just its weekend total). The yearly and all-time views are parsed from Wikipedia and may use different reporting conventions. Grosses can be revised after initial publication; this is an independent fan project, not an official reporting service.
              </p>
              <p className="mt-2 text-xs leading-6 text-[#65766f]">
                The weekly feed tries a few public CORS proxies so this browser-only React app can request Box Office Mojo. Public proxies can still be rate-limited or unavailable; a small server-side proxy is the most reliable long-term option.
              </p>
            </div>
            <div className="flex flex-wrap gap-x-4 gap-y-2 text-xs">
              <a href={sourceUrl} target="_blank" rel="noreferrer" className="text-[#65d6bd] underline decoration-[#3b5c53] underline-offset-4 hover:text-white">Box Office Mojo ↗</a>
              <a href={SOURCE_URLS.current} target="_blank" rel="noreferrer" className="text-[#a4b0aa] underline decoration-[#3b5c53] underline-offset-4 hover:text-[#65d6bd]">Wikipedia year chart ↗</a>
              <a href={SOURCE_URLS.alltime} target="_blank" rel="noreferrer" className="text-[#a4b0aa] underline decoration-[#3b5c53] underline-offset-4 hover:text-[#65d6bd]">Wikipedia all-time chart ↗</a>
            </div>
          </div>
          <div className="mt-8 flex flex-wrap justify-between gap-2 border-t border-[#20332e] pt-4 text-[10px] uppercase tracking-[0.15em] text-[#65766f]">
            <span>Box Office Records</span>
            <span>Black · Teal · Editorial</span>
          </div>
        </footer>
      </div>
    </div>
  );
}

export default App;
