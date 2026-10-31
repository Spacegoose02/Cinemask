import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { Alert, LoadError } from '../components/ui';
import { api } from '../lib/api';
import { useAuth } from '../lib/auth';
import { mediaPath, poster, type MediaKind } from '../lib/media';

type Game = 'trivia' | 'scene';

interface Round {
  id: string;
  game: Game;
  questions: { prompt: string; detail: string | null; image: string | null; choices: string[] }[];
}

interface Scored {
  score: number;
  total: number;
  results: { correct: boolean; answer: number; chosen: number | null; kind: MediaKind; tmdbId: number; title: string }[];
  streak: { current: number; best: number };
}

interface Leaderboard {
  week: { userId: number; name: string; rounds: number; correct: number; best: number; perfect: number }[];
  streak: { current: number; best: number };
}

const GAMES: { id: Game; name: string; emoji: string; about: string }[] = [
  { id: 'trivia', name: 'Trivia', emoji: '🧠', about: 'Years, plots, ratings and genres from your own library.' },
  { id: 'scene', name: 'Guess the scene', emoji: '🎬', about: 'Name the movie or show from a single still.' },
];

const cheer = (score: number, total: number) =>
  score === total ? 'Perfect round! The raccoon is impressed.' : score >= total - 1 ? 'So close. One more go?' : score >= total / 2 ? 'Not bad at all.' : 'The raccoon thinks you need a movie marathon.';

function Play({ round, onDone }: { round: Round; onDone: () => void }) {
  const qc = useQueryClient();
  const [answers, setAnswers] = useState<(number | null)[]>([]);
  const [scored, setScored] = useState<Scored | null>(null);
  const [error, setError] = useState('');
  // Answers as tapped, ahead of the re-render: a quick double tap mustn't answer twice or send the round twice.
  const given = useRef<number[]>([]);
  const shownAt = useRef(-Infinity);
  const i = answers.length;
  const q = round.questions[i];

  const choose = async (choice: number, question: number, at: number) => {
    // A tap meant for the last question that lands on the next one (a double tap) is ignored for a moment.
    if (question !== given.current.length || at - shownAt.current < 300) return;
    const next = [...given.current, choice];
    given.current = next;
    shownAt.current = at;
    setAnswers(next);
    if (next.length < round.questions.length) return;
    try {
      setScored(await api<Scored>(`/api/games/rounds/${round.id}/answers`, { body: { answers: next } }));
      await qc.invalidateQueries({ queryKey: ['leaderboard'] });
      await qc.invalidateQueries({ queryKey: ['badges'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (error) {
    return (
      <section className="card space-y-3">
        <Alert>{error}</Alert>
        <button className="btn-primary" onClick={onDone}>
          Start a new round
        </button>
      </section>
    );
  }
  if (scored) {
    return (
      <section className="card space-y-4">
        <div className="text-center">
          <div className="text-5xl font-bold text-accent">
            {scored.score}/{scored.total}
          </div>
          <p className="mt-1">{cheer(scored.score, scored.total)}</p>
          {scored.streak.current > 1 && <p className="text-sm text-muted">🔥 {scored.streak.current} days in a row</p>}
        </div>
        <ol className="space-y-2">
          {scored.results.map((r, n) => {
            const question = round.questions[n]!;
            return (
              <li key={n} className="rounded-md border border-border p-3 text-sm">
                <div className="font-medium">
                  {r.correct ? '✅' : '❌'} {question.prompt}
                </div>
                {question.detail && <p className="line-clamp-1 text-xs text-muted">{question.detail}</p>}
                <div className="text-muted">
                  {!r.correct && r.chosen !== null && <span className="line-through">{question.choices[r.chosen]}</span>} {question.choices[r.answer]} ·{' '}
                  <Link to={mediaPath(r.kind, r.tmdbId)} className="text-accent">
                    {r.title}
                  </Link>
                </div>
              </li>
            );
          })}
        </ol>
        <button className="btn-primary" onClick={onDone}>
          Play again
        </button>
      </section>
    );
  }
  if (!q) return <div className="text-muted">Scoring…</div>;
  return (
    <section className="card space-y-4">
      <div className="flex items-center justify-between text-sm text-muted">
        <span>
          Question {i + 1} of {round.questions.length}
        </span>
        <div className="flex gap-1">
          {round.questions.map((_, n) => (
            <span key={n} className={`h-2 w-6 rounded-full ${n < i ? 'bg-accent' : n === i ? 'bg-accent/50' : 'bg-surface-2'}`} />
          ))}
        </div>
      </div>
      <h2 className="text-xl font-semibold">{q.prompt}</h2>
      {q.image && <img src={poster(q.image, 'w780')!} alt="A scene from the title to guess" className="w-full rounded-lg border border-border" />}
      {q.detail && <p className="rounded-md bg-surface-2 p-3 text-sm leading-relaxed">{q.detail}</p>}
      <div className="grid gap-2 sm:grid-cols-2">
        {q.choices.map((c, n) => (
          <button key={`${i}-${n}`} className="btn-secondary justify-start whitespace-normal py-3 text-left" onClick={(e) => choose(n, i, e.timeStamp)}>
            {c}
          </button>
        ))}
      </div>
    </section>
  );
}

export function GamesPage() {
  const { me } = useAuth();
  const [round, setRound] = useState<Round | null>(null);
  const [error, setError] = useState('');
  const board = useQuery({ queryKey: ['leaderboard'], queryFn: () => api<Leaderboard>('/api/games/leaderboard') });

  const start = async (game: Game) => {
    setError('');
    try {
      setRound(await api<Round>(`/api/games/${game}/rounds`, { method: 'POST' }));
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-semibold">Games</h1>
          <p className="text-sm text-muted">Five quick questions about what's on your servers. Play every day to keep your streak going.</p>
        </div>
        {board.data && (
          <div className="text-sm text-muted">
            🔥 Streak: <span className="font-semibold text-text">{board.data.streak.current}</span> day{board.data.streak.current === 1 ? '' : 's'} · best {board.data.streak.best}
          </div>
        )}
      </div>
      {error && <Alert>{error}</Alert>}
      <LoadError queries={[board]} />
      {round ? (
        <Play key={round.id} round={round} onDone={() => setRound(null)} />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {GAMES.map((g) => (
            <button key={g.id} className="card text-left transition hover:border-accent" onClick={() => start(g.id)}>
              <div className="text-3xl">{g.emoji}</div>
              <div className="mt-2 text-lg font-semibold">{g.name}</div>
              <div className="text-sm text-muted">{g.about}</div>
            </button>
          ))}
        </div>
      )}
      <section className="card">
        <h2 className="mb-3 font-semibold">This week's leaderboard</h2>
        {board.data?.week.length ? (
          <table className="w-full text-sm">
            <thead className="text-left text-muted">
              <tr>
                <th className="py-1 font-normal">#</th>
                <th className="font-normal">Player</th>
                <th className="text-right font-normal">Points</th>
                <th className="text-right font-normal">Rounds</th>
                <th className="text-right font-normal">Perfect</th>
              </tr>
            </thead>
            <tbody>
              {board.data.week.map((r, n) => (
                <tr key={r.userId} className={`border-t border-border ${r.userId === me?.id ? 'text-accent' : ''}`}>
                  <td className="py-1.5">{['🥇', '🥈', '🥉'][n] ?? n + 1}</td>
                  <td>{r.name}</td>
                  <td className="text-right">{r.correct}</td>
                  <td className="text-right">{r.rounds}</td>
                  <td className="text-right">{r.perfect}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <p className="text-sm text-muted">Nobody has played this week. Be the first!</p>
        )}
      </section>
    </div>
  );
}
