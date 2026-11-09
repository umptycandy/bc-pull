import type { Config } from "@netlify/functions"

const FEED = "https://bleedingcool.com/comics/feed/"
const PAGES = [1, 2, 3] // WordPress feeds accept ?paged=N for older posts; duplicates are dropped
const UA = "Mozilla/5.0 (compatible; comics-feed-reader/1.0)"

const decode = (s = "") =>
  s
    .replace(/^<!\[CDATA\[|\]\]>$/g, "")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;|&#039;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&nbsp;/g, " ")
    .replace(/&hellip;/g, "…")
    .replace(/&amp;/g, "&")
    .trim()

const tag = (xml: string, name: string) => {
  const m = xml.match(new RegExp(`<${name}[^>]*>([\\s\\S]*?)</${name}>`, "i"))
  return m ? decode(m[1]) : ""
}

export function parseFeed(xml: string) {
  const items = [...xml.matchAll(/<item>([\s\S]*?)<\/item>/gi)].map((m) => m[1])
  return items.map((it) => {
    const rawAuthor = tag(it, "dc:creator")
    // Strip struck-through names (e.g. <s>Jude Terror</s>) so the real byline remains
    const author = rawAuthor.replace(/<s>[\s\S]*?<\/s>/gi, "").replace(/<[^>]+>/g, "").trim()
    const categories = [...it.matchAll(/<category[^>]*>([\s\S]*?)<\/category>/gi)].map((c) => decode(c[1]))
    const description = tag(it, "description").replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim()
    const link = tag(it, "link")
    return {
      id: tag(it, "guid") || link,
      title: tag(it, "title"),
      link,
      date: new Date(tag(it, "pubDate")).toISOString(),
      author,
      categories,
      description,
      image: "",
    }
  })
}

async function getText(url: string, ms = 6000) {
  const res = await fetch(url, { headers: { "user-agent": UA }, signal: AbortSignal.timeout(ms) })
  if (!res.ok) throw new Error(`${res.status} ${url}`)
  return res.text()
}

async function ogImage(url: string) {
  try {
    const html = await getText(url, 4000)
    const m =
      html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i) ||
      html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+property=["']og:image["']/i)
    return m ? decode(m[1]) : ""
  } catch {
    return ""
  }
}

async function mapLimit<T, R>(arr: T[], limit: number, fn: (x: T) => Promise<R>) {
  const out: R[] = new Array(arr.length)
  let i = 0
  const workers = Array.from({ length: Math.min(limit, arr.length) }, async () => {
    while (i < arr.length) {
      const idx = i++
      out[idx] = await fn(arr[idx])
    }
  })
  await Promise.all(workers)
  return out
}

export default async (req: Request) => {
  const skipImages = new URL(req.url).searchParams.has("noimages")
  const pages = await Promise.allSettled(
    PAGES.map((p) => getText(p === 1 ? FEED : `${FEED}?paged=${p}`))
  )
  const seen = new Set<string>()
  const items = pages
    .flatMap((p) => (p.status === "fulfilled" ? parseFeed(p.value) : []))
    .filter((it) => (seen.has(it.id) ? false : (seen.add(it.id), true)))
    .sort((a, b) => b.date.localeCompare(a.date))

  if (!items.length) {
    return Response.json({ error: "Couldn't load the Bleeding Cool feed" }, { status: 502 })
  }

  if (!skipImages) {
    const imgs = await mapLimit(items, 12, (it) => ogImage(it.link))
    imgs.forEach((src, i) => (items[i].image = src))
  }

  return Response.json(
    { fetched: new Date().toISOString(), items },
    {
      headers: {
        "cache-control": "public, max-age=0, must-revalidate",
        // Netlify's CDN keeps the result for 15 min, so article pages aren't re-scraped on every visit
        "netlify-cdn-cache-control": "public, s-maxage=900, stale-while-revalidate=3600",
      },
    }
  )
}

export const config: Config = { path: "/api/feed" }
