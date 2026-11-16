import 'dotenv/config';
import express from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { GoogleGenAI, Type, ThinkingLevel } from '@google/genai';
import nodemailer from 'nodemailer';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ─── Types ───
interface UserRecord {
  id: number;
  email: string;
  otp: string | null;
  otpExpiresAt: number | null;
  createdAt: string;
}

interface ArticleRecord {
  id: number;
  user_id: number;
  url: string;
  title: string;
  content: string;
  summary: string;
  insights: string;
  created_at: string;
}

interface AnalysisResult {
  problem: string;
  methodology: string;
  results: string;
  conclusion: string;
  contributions: string[];
  evolution: string;
  research_gaps: string;
}

interface SeedData {
  users: Array<{ id: number; email: string }>;
  articles: Array<{
    id: number;
    user_id: number;
    url: string;
    title: string;
    content: string;
    summary: string;
    insights: string;
    created_at: string;
  }>;
}

interface AuthedRequest extends Request {
  currentUser?: UserRecord;
}

// ─── In-Memory Store (Seeded from exported memento.db data) ───
const usersByEmail = new Map<string, UserRecord>();
const articles: ArticleRecord[] = [];
let nextUserId = 1;
let nextArticleId = 1;

function loadSeedData(): void {
  const seedPath = path.join(__dirname, 'src', 'seed.json');
  if (!fs.existsSync(seedPath)) {
    return;
  }

  try {
    const raw = fs.readFileSync(seedPath, 'utf-8');
    const seed = JSON.parse(raw) as SeedData;

    for (const u of seed.users) {
      const normalized = u.email.trim().toLowerCase();
      usersByEmail.set(normalized, {
        id: u.id,
        email: normalized,
        otp: null,
        otpExpiresAt: null,
        createdAt: new Date().toISOString(),
      });
      if (u.id >= nextUserId) nextUserId = u.id + 1;
    }

    for (const a of seed.articles) {
      articles.push({ ...a });
      if (a.id >= nextArticleId) nextArticleId = a.id + 1;
    }

    // Ensure demo/user accounts have starter papers ready for instant comparison & chat
    const demoAccounts: Array<{ email: string; starterIds: number[] }> = [
      { email: 'test@example.com', starterIds: [4, 5, 14] },
      { email: 'maheshgundala04@gmail.com', starterIds: [4, 5] },
    ];

    for (const acc of demoAccounts) {
      let user = usersByEmail.get(acc.email);
      if (!user) {
        user = {
          id: nextUserId++,
          email: acc.email,
          otp: null,
          otpExpiresAt: null,
          createdAt: new Date().toISOString(),
        };
        usersByEmail.set(acc.email, user);
      }
      const hasArticles = articles.some((a) => a.user_id === user!.id);
      if (!hasArticles) {
        for (const sid of acc.starterIds) {
          const src = seed.articles.find((a) => a.id === sid);
          if (src) {
            articles.push({
              ...src,
              id: nextArticleId++,
              user_id: user.id,
            });
          }
        }
      }
    }
  } catch (err) {
    console.warn('Could not load seed data:', err);
  }
}

loadSeedData();

function getValidEnv(name: string, placeholders: string[] = []): string | null {
  const val = process.env[name]?.trim();
  if (!val) return null;
  if (placeholders.includes(val) || val.startsWith('your_') || val.startsWith('MY_')) {
    return null;
  }
  return val;
}

// ─── Gemini Client (Server-Side Only) ───
function getGeminiClient(): GoogleGenAI | null {
  const apiKey = getValidEnv('GEMINI_API_KEY', ['MY_GEMINI_API_KEY', 'your_gemini_api_key_here']);
  if (!apiKey) {
    return null;
  }
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

async function callGroqIfConfigured(prompt: string, isJson: boolean): Promise<string | null> {
  const groqKey = getValidEnv('GROQ_API_KEY', ['gsk_your_key_here', 'your_groq_api_key_here']);
  if (!groqKey) {
    return null;
  }

  try {
    const res = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${groqKey}`,
      },
      body: JSON.stringify({
        model: 'llama-3.3-70b-versatile',
        messages: [{ role: 'user', content: prompt }],
        ...(isJson ? { response_format: { type: 'json_object' } } : {}),
      }),
    });

    if (!res.ok) {
      return null;
    }

    const data = (await res.json()) as {
      choices?: Array<{ message?: { content?: string } }>;
    };
    return data.choices?.[0]?.message?.content ?? null;
  } catch {
    return null;
  }
}

async function callLLM(prompt: string, isJson = false): Promise<string> {
  const groqResponse = await callGroqIfConfigured(prompt, isJson);
  if (groqResponse) {
    return groqResponse;
  }

  const ai = getGeminiClient();
  if (!ai) {
    throw new Error('GEMINI_API_KEY is not configured in environment secrets.');
  }

  const attempts: Array<{ model: string; thinkingLevel: ThinkingLevel }> = [
    { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW },
    { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
    { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW },
    { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL },
  ];

  let lastError: unknown;

  for (let i = 0; i < attempts.length; i++) {
    const { model, thinkingLevel } = attempts[i];
    try {
      const config = isJson
        ? {
            thinkingConfig: { thinkingLevel },
            responseMimeType: 'application/json',
            responseSchema: {
              type: Type.OBJECT,
              properties: {
                problem: { type: Type.STRING },
                methodology: { type: Type.STRING },
                results: { type: Type.STRING },
                conclusion: { type: Type.STRING },
                contributions: {
                  type: Type.ARRAY,
                  items: { type: Type.STRING },
                },
                evolution: { type: Type.STRING },
                research_gaps: { type: Type.STRING },
              },
              required: [
                'problem',
                'methodology',
                'results',
                'conclusion',
                'contributions',
                'evolution',
                'research_gaps',
              ],
            },
          }
        : {
            thinkingConfig: { thinkingLevel },
          };

      const response = await ai.models.generateContent({
        model,
        contents: prompt,
        config,
      });

      return response.text ?? (isJson ? '{}' : '');
    } catch (err) {
      lastError = err;
      const msg = err instanceof Error ? err.message : String(err);
      const isTransient =
        msg.includes('503') ||
        msg.includes('UNAVAILABLE') ||
        msg.includes('high demand') ||
        msg.includes('429') ||
        msg.includes('RESOURCE_EXHAUSTED');
      if (isTransient && i < attempts.length - 1) {
        await new Promise((r) => setTimeout(r, 800 * (i + 1)));
        continue;
      }
      throw err;
    }
  }

  throw lastError instanceof Error ? lastError : new Error('LLM request failed.');
}

// ─── Web Scraping Service (Firecrawl + Native Fetch Fallback) ───
function htmlToReadableText(html: string): { title: string; content: string } {
  const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  const rawTitle = titleMatch ? titleMatch[1] : 'Untitled Research Document';
  const title = rawTitle
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();

  let cleaned = html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<svg[\s\S]*?<\/svg>/gi, ' ')
    .replace(/<(h[1-6]|p|div|li|br|tr|section|article)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  if (cleaned.length > 100000) {
    cleaned = cleaned.slice(0, 100000);
  }

  return { title: title || 'Untitled Research Document', content: cleaned };
}

async function scrapeUrl(rawUrl: string): Promise<{ title: string; content: string }> {
  const firecrawlKey = getValidEnv('FIRECRAWL_API_KEY', ['your_firecrawl_api_key_here']);
  if (firecrawlKey) {
    const fcRes = await fetch('https://api.firecrawl.dev/v1/scrape', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${firecrawlKey}`,
      },
      body: JSON.stringify({
        url: rawUrl,
        formats: ['markdown'],
      }),
    });

    if (fcRes.ok) {
      const fcJson = (await fcRes.json()) as {
        data?: { markdown?: string; metadata?: { title?: string } };
      };
      const md = fcJson.data?.markdown ?? '';
      const title = fcJson.data?.metadata?.title ?? 'Unknown Title';
      if (md.trim().length > 0) {
        return { title, content: md };
      }
    }
  }

  // Fallback: fetch URL directly (converting arxiv /pdf/ links to /abs/ for HTML extraction)
  let targetUrl = rawUrl;
  if (targetUrl.includes('arxiv.org/pdf/')) {
    targetUrl = targetUrl.replace('arxiv.org/pdf/', 'arxiv.org/abs/').replace(/\.pdf$/i, '');
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(targetUrl, {
      signal: controller.signal,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; ResearchFlowAI/1.0)',
        Accept: 'text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status} while fetching URL`);
    }

    const contentType = response.headers.get('content-type') || '';

    if (contentType.includes('application/pdf')) {
      const buf = Buffer.from(await response.arrayBuffer());
      if (buf.byteLength > 10 * 1024 * 1024) {
        throw new Error('PDF file exceeds 10MB limit without Firecrawl.');
      }
      const ai = getGeminiClient();
      if (!ai) {
        throw new Error('GEMINI_API_KEY is required to extract PDF content.');
      }
      const pdfRes = await ai.models.generateContent({
        model: 'gemini-4-hydrogen',
        contents: {
          parts: [
            {
              inlineData: {
                mimeType: 'application/pdf',
                data: buf.toString('base64'),
              },
            },
            {
              text: 'Extract the paper title on the first line (prefixed with TITLE: ) followed by the complete readable text of this research paper including abstract, methodology, experiments, results, and conclusion.',
            },
          ],
        },
        config: {
          thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
        },
      });
      const extractedText = (pdfRes.text ?? '').trim();
      const firstLineMatch = extractedText.match(/^TITLE:\s*(.+)/i);
      const pdfTitle = firstLineMatch
        ? firstLineMatch[1].trim()
        : decodeURIComponent(targetUrl.split('/').pop() || 'PDF Research Paper');
      return {
        title: pdfTitle,
        content: extractedText.slice(0, 100000),
      };
    }

    const bodyText = await response.text();

    if (contentType.includes('text/plain') || contentType.includes('text/markdown')) {
      return {
        title: targetUrl.split('/').pop() || targetUrl,
        content: bodyText.slice(0, 100000),
      };
    }

    const extracted = htmlToReadableText(bodyText);
    if (extracted.content && extracted.content.length >= 120) {
      return extracted;
    }
    throw new Error('Thin or JS-rendered content extracted from direct fetch.');
  } catch (directErr) {
    // Fallback to Gemini urlContext for publisher-protected or JS-rendered pages
    const ai = getGeminiClient();
    if (ai) {
      try {
        const ctxRes = await ai.models.generateContent({
          model: 'gemini-4-hydrogen',
          contents: `Read the web page or research paper at ${rawUrl} and extract its exact title on the first line prefixed with "TITLE: " followed by the detailed technical content (abstract, problem, methodology, experiments, results, conclusion).`,
          config: {
            tools: [{ urlContext: {} }],
            thinkingConfig: { thinkingLevel: ThinkingLevel.LOW },
          },
        });
        const ctxText = (ctxRes.text ?? '').trim();
        if (ctxText.length >= 80) {
          const titleMatch = ctxText.match(/^TITLE:\s*(.+)/i);
          const ctxTitle = titleMatch
            ? titleMatch[1].trim()
            : rawUrl;
          return {
            title: ctxTitle,
            content: ctxText.slice(0, 100000),
          };
        }
      } catch {
        // Fall through to original error
      }
    }
    throw directErr;
  } finally {
    clearTimeout(timeout);
  }
}

// ─── LLM Synthesis Functions ───
async function analyzeArticle(
  content: string,
  previousPapers: Array<{ title: string; summary: string }> = []
): Promise<AnalysisResult> {
  const summaryContent = content.slice(0, 100000);

  let evolutionContext = '';
  if (previousPapers.length > 0) {
    evolutionContext = '\n--- Previous Papers for Context ---\n';
    for (const p of previousPapers) {
      evolutionContext += `- Title: ${p.title}\n  Summary: ${p.summary.slice(0, 500)}...\n`;
    }
  }

  const prompt = `You are a senior AI research analyst. Analyze the provided content from the URL and output a clear, well-structured analysis in valid JSON format.

Strict Rules:
1. Return ONLY valid JSON. No markdown blocks, no preamble, no postscript.
2. Use ONLY double quotes for all strings and keys.
3. Always populate every field clearly based on the URL content (even for technical blogs, documentation, or articles as well as research papers).
4. Contributions MUST be a JSON array of short, clear strings.
5. For 'problem', provide a clear, complete summary of what this URL/paper is about and the core problem or topic it addresses.
6. For 'methodology', clearly explain the method, technique, architecture, workflow, or approach used in the URL/paper.
7. For 'results', clearly state the findings, outcomes, benchmarks, and final result achieved.
8. For 'conclusion', state the concise final takeaway/result.
${evolutionContext}
JSON Structure:
{
  "problem": "Clear summary of what the URL covers and the core problem/topic",
  "methodology": "Clear explanation of the method, techniques, architecture, or approach used",
  "results": "Key findings, outcomes, and the final result",
  "conclusion": "Concise final takeaway/result",
  "contributions": ["Short contribution 1", "Short contribution 2"],
  "evolution": "Comparison with prior work, improvements, and trends",
  "research_gaps": "Limitations, open questions, or missing areas"
}

URL Content:
${summaryContent}`;

  const rawText = await callLLM(prompt, true);
  let parsed: Partial<AnalysisResult> = {};

  try {
    parsed = JSON.parse(rawText) as Partial<AnalysisResult>;
  } catch {
    const cleaned = rawText.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    try {
      parsed = JSON.parse(cleaned) as Partial<AnalysisResult>;
    } catch {
      parsed = { problem: rawText || 'Error parsing LLM response' };
    }
  }

  return {
    problem: parsed.problem ?? '',
    methodology: parsed.methodology ?? '',
    results: parsed.results ?? '',
    conclusion: parsed.conclusion ?? '',
    contributions: Array.isArray(parsed.contributions)
      ? parsed.contributions.map(String)
      : parsed.contributions
        ? [String(parsed.contributions)]
        : [],
    evolution: parsed.evolution ?? 'No evolution context provided.',
    research_gaps: parsed.research_gaps ?? '',
  };
}

async function compareArticles(
  articlesData: Array<{ title: string; content: string }>
): Promise<string> {
  let articlesText = '';
  articlesData.forEach((art, idx) => {
    const snippet = art.content.slice(0, 8000);
    articlesText += `\n--- Paper ${idx + 1}: ${art.title} ---\n${snippet}\n`;
  });

  const prompt = `You are an expert research analyst. Compare the given ${articlesData.length} research papers and provide a deep, structured comparison.

CRITICAL: You MUST use the following exact markers for each section so the system can parse them:
[OVERVIEW]
[METHODOLOGY]
[RESULTS]
[CONTRIBUTIONS]
[EVOLUTION]
[GAPS]
[SUMMARY]

Within each section, explicitly label the analysis for each paper as:
Paper 1: (your analysis)
Paper 2: (your analysis)

Ensure the output is technical and formatted for clear side-by-side reading.

Papers to Compare:
${articlesText}`;

  const comparisonText = await callLLM(prompt, false);
  return comparisonText || 'No comparison generated.';
}

async function chatAboutArticle(content: string, query: string): Promise<string> {
  const prompt = `You are ResearchFlow AI, a brilliant and technical research assistant.

BEHAVIOR GUIDELINES:
1. Respond politely to greetings and invite research questions.
2. Provide deep technical insights based on the content below.
3. If unsure, state you're based on the provided text.

Research Paper Content:
${content.slice(0, 20000)}

User Question: ${query}`;

  const responseText = await callLLM(prompt, false);
  return responseText || "I couldn't generate a response.";
}

// ─── Response Formatter ───
function formatArticleResponse(article: ArticleRecord) {
  let data: Partial<AnalysisResult> = {};
  try {
    data = JSON.parse(article.summary) as Partial<AnalysisResult>;
  } catch {
    const match = article.summary.match(/```json\s*([\s\S]*?)```/i);
    if (match) {
      try {
        data = JSON.parse(match[1].trim()) as Partial<AnalysisResult>;
      } catch {
        data = { problem: article.summary };
      }
    } else {
      data = { problem: article.summary };
    }
  }

  const contributionsStr = Array.isArray(data.contributions)
    ? data.contributions.join(', ')
    : String(data.contributions ?? '');

  return {
    id: article.id,
    url: article.url,
    title: article.title,
    summary: article.summary,
    insights: article.insights,
    problem: data.problem ?? '',
    methodology: data.methodology ?? '',
    results: data.results ?? '',
    conclusion: data.conclusion ?? '',
    contributions: contributionsStr,
    research_gaps: data.research_gaps ?? '',
    created_at: article.created_at,
  };
}

// ─── Express App ───
const app = express();
app.use(express.json({ limit: '2mb' }));

function requireAuth(req: AuthedRequest, res: Response, next: NextFunction): void {
  const headerEmail = req.header('x-user-email');
  if (!headerEmail) {
    res.status(401).json({ detail: 'Not authenticated' });
    return;
  }

  const normalized = headerEmail.trim().toLowerCase();
  let user = usersByEmail.get(normalized);
  if (!user) {
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
      res.status(401).json({ detail: 'User not found' });
      return;
    }
    user = {
      id: nextUserId++,
      email: normalized,
      otp: null,
      otpExpiresAt: null,
      createdAt: new Date().toISOString(),
    };
    usersByEmail.set(normalized, user);
  }

  req.currentUser = user;
  next();
}

async function sendOtpEmailIfConfigured(recipientEmail: string, otp: string): Promise<boolean> {
  const host = getValidEnv('EMAIL_HOST');
  const port = Number(process.env.EMAIL_PORT || '587');
  const user = getValidEnv('EMAIL_USER', ['your_smtp_username_here']);
  const pass = getValidEnv('EMAIL_PASS', ['your_smtp_password_here']);
  const sender = getValidEnv('SENDER_EMAIL', ['sender@example.com']);

  if (!host || !user || !pass || !sender) {
    return false;
  }

  const transporter = nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user, pass },
  });

  await transporter.sendMail({
    from: sender,
    to: recipientEmail,
    subject: 'Your ResearchFlow AI Login Code',
    text: `Your OTP code is: ${otp}`,
    html: `
      <html>
        <body style="font-family: Arial, sans-serif; background-color: #f4f4f5; padding: 20px;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 40px; border-radius: 8px;">
            <h2 style="color: #111827; text-align: center; margin-bottom: 24px;">ResearchFlow AI Sign-In</h2>
            <p style="color: #4b5563; font-size: 16px;">Here is your secure 6-digit code. It expires in 10 minutes.</p>
            <div style="background-color: #f3f4f6; border-radius: 8px; padding: 20px; text-align: center; margin: 30px 0;">
              <span style="font-size: 32px; font-weight: bold; letter-spacing: 8px; color: #2d5a27;">${otp}</span>
            </div>
          </div>
        </body>
      </html>
    `,
  });

  return true;
}

// Auth: Request OTP
app.post('/api/auth/login', async (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  if (!email) {
    res.status(400).json({ detail: 'Email is required' });
    return;
  }

  let user = usersByEmail.get(email);
  if (!user) {
    user = {
      id: nextUserId++,
      email,
      otp: null,
      otpExpiresAt: null,
      createdAt: new Date().toISOString(),
    };
    usersByEmail.set(email, user);
  }

  const otp = String(Math.floor(100000 + Math.random() * 900000));
  user.otp = otp;
  user.otpExpiresAt = Date.now() + 10 * 60 * 1000;

  try {
    const emailSent = await sendOtpEmailIfConfigured(user.email, otp);
    if (emailSent) {
      res.json({ message: 'OTP sent to email' });
      return;
    }
    res.json({
      message: 'OTP sent to email',
      devOtp: otp,
    });
  } catch (err) {
    user.otp = null;
    user.otpExpiresAt = null;
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail: `Failed to send email: ${msg}` });
  }
});

// Auth: Verify OTP
app.post('/api/auth/verify-otp', (req: Request, res: Response) => {
  const email = String(req.body?.email ?? '').trim().toLowerCase();
  const otp = String(req.body?.otp ?? '').trim();

  const user = usersByEmail.get(email);
  if (!user || user.otp !== otp) {
    res.status(401).json({ detail: 'Invalid OTP' });
    return;
  }

  if (user.otpExpiresAt && user.otpExpiresAt < Date.now()) {
    res.status(401).json({ detail: 'OTP has expired' });
    return;
  }

  user.otp = null;
  user.otpExpiresAt = null;

  res.json({ message: 'Login successful', email: user.email });
});

// Analyze & Store Article
app.post('/api/analyze', requireAuth, async (req: AuthedRequest, res: Response) => {
  const currentUser = req.currentUser!;
  let url = String(req.body?.url ?? '').trim();
  const forceAnalyze = Boolean(req.body?.force_analyze);

  if (!url) {
    res.status(400).json({ detail: 'URL cannot be empty' });
    return;
  }
  if (!/^https?:\/\//i.test(url)) {
    if (url.includes('.')) {
      url = `https://${url}`;
    } else {
      res.status(400).json({ detail: 'Invalid URL format' });
      return;
    }
  }

  const existingArticle = articles.find(
    (a) => a.url === url && a.user_id === currentUser.id
  );
  if (existingArticle && !forceAnalyze) {
    res.status(409).json({
      detail: 'This paper already exists in your dashboard. Analyze again?',
    });
    return;
  }

  let scrapeData: { title: string; content: string };
  try {
    scrapeData = await scrapeUrl(url);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail: `Scrape error: ${msg}` });
    return;
  }

  const title = scrapeData.title.trim() || url;
  if (!forceAnalyze) {
    const duplicate = articles.find(
      (a) => a.title === title && a.user_id === currentUser.id
    );
    if (duplicate) {
      res.status(400).json({
        detail: 'This paper may already exist in your dashboard (matched by title)',
      });
      return;
    }
  }

  const userArticles = articles
    .filter((a) => a.user_id === currentUser.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime())
    .slice(0, 3);

  const prevData = userArticles.map((p) => ({ title: p.title, summary: p.summary }));

  let analysisData: AnalysisResult;
  try {
    analysisData = await analyzeArticle(scrapeData.content, prevData);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail: `LLM error: ${msg}` });
    return;
  }

  const newArticle: ArticleRecord = {
    id: nextArticleId++,
    user_id: currentUser.id,
    url,
    title,
    content: scrapeData.content,
    summary: JSON.stringify(analysisData),
    insights: analysisData.evolution || 'No evolution context provided.',
    created_at: new Date().toISOString().replace('T', ' ').slice(0, 19),
  };

  articles.push(newArticle);
  res.json(formatArticleResponse(newArticle));
});

// List Mementos
app.get('/api/mementos', requireAuth, (req: AuthedRequest, res: Response) => {
  const currentUser = req.currentUser!;
  const userArticles = articles
    .filter((a) => a.user_id === currentUser.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  res.json(userArticles.map(formatArticleResponse));
});

// Compare Mementos
app.post('/api/compare', requireAuth, async (req: AuthedRequest, res: Response) => {
  const currentUser = req.currentUser!;
  const articleIds = Array.isArray(req.body?.article_ids)
    ? (req.body.article_ids as number[])
    : [];

  if (articleIds.length < 2) {
    res.json({ success: false, error: 'Please select at least 2 papers to compare.' });
    return;
  }

  const selected = articles.filter(
    (a) => articleIds.includes(a.id) && a.user_id === currentUser.id
  );

  if (selected.length === 0) {
    res.json({ success: false, error: 'Selected papers not found in your library.' });
    return;
  }

  try {
    const comparisonText = await compareArticles(
      selected.map((a) => ({ title: a.title, content: a.content }))
    );
    if (!comparisonText.trim()) {
      res.json({ success: false, error: 'LLM returned an empty comparison.' });
      return;
    }
    res.json({ success: true, comparison: comparisonText });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.json({ success: false, error: `LLM comparison failed: ${msg}` });
  }
});

// Chat About Memento
app.post('/api/chat', requireAuth, async (req: AuthedRequest, res: Response) => {
  const currentUser = req.currentUser!;
  const articleId = Number(req.body?.article_id);
  const query = String(req.body?.query ?? '').trim();

  const article = articles.find(
    (a) => a.id === articleId && a.user_id === currentUser.id
  );
  if (!article) {
    res.status(404).json({ detail: 'Article not found' });
    return;
  }

  try {
    const reply = await chatAboutArticle(article.content, query);
    res.json({ response: reply });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    res.status(500).json({ detail: msg });
  }
});

// Delete Memento
app.delete('/api/mementos/:article_id', requireAuth, (req: AuthedRequest, res: Response) => {
  const currentUser = req.currentUser!;
  const articleId = Number(req.params.article_id);

  const idx = articles.findIndex(
    (a) => a.id === articleId && a.user_id === currentUser.id
  );
  if (idx === -1) {
    res.status(404).json({ detail: 'Article not found' });
    return;
  }

  articles.splice(idx, 1);
  res.json({ message: 'Deleted successfully' });
});

// Stats
app.get('/api/stats', requireAuth, (req: AuthedRequest, res: Response) => {
  const currentUser = req.currentUser!;
  const userArticles = articles
    .filter((a) => a.user_id === currentUser.id)
    .sort((a, b) => new Date(b.created_at).getTime() - new Date(a.created_at).getTime());

  const totalPapers = userArticles.length;
  const recentTitle = totalPapers > 0 ? userArticles[0].title : 'None';
  const totalWords = userArticles.reduce(
    (sum, a) => sum + (a.content ? a.content.split(/\s+/).length : 0),
    0
  );

  res.json({
    total_papers: totalPapers,
    recent_title: recentTitle,
    total_words: totalWords,
  });
});

// Serve Static Frontend
const frontendDir = path.join(__dirname, 'frontend');
app.use(express.static(frontendDir));

app.get('/', (_req: Request, res: Response) => {
  res.sendFile(path.join(frontendDir, 'index.html'));
});

const PORT = Number(process.env.PORT) || 3000;
app.listen(PORT, '0.0.0.0', () => {
  console.log(`ResearchFlow AI server listening on http://0.0.0.0:${PORT}`);
});
