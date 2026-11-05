import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../lib/api';
import type { MediaDetail } from '../pages/MediaDetail';
import { scopeOf } from '../pages/Issues';
import { Modal } from './Modal';
import { Alert } from './ui';

const TYPES: [string, string][] = [
  ['audio', 'Wrong language or bad audio'],
  ['subtitles', 'Missing or wrong subtitles'],
  ['video', 'Poor picture quality'],
  ['playback', "Won't play"],
  ['wrong', "It's the wrong movie or episode"],
  ['other', 'Something else'],
];

interface TitleIssue {
  id: number;
  label: string;
  season: number | null;
  episode: number | null;
  status: string;
  mine: boolean;
}

/** "Report a problem" on a title page, and the reports already open for it. */
export function ReportProblem({ m }: { m: MediaDetail }) {
  const qc = useQueryClient();
  const open = useQuery({ queryKey: ['title-issues', m.kind, m.tmdbId], queryFn: () => api<TitleIssue[]>(`/api/issues/title/${m.kind}/${m.tmdbId}`) });
  const [show, setShow] = useState(false);
  const [type, setType] = useState('audio');
  const [season, setSeason] = useState<number | ''>('');
  const [episode, setEpisode] = useState<number | ''>('');
  const [message, setMessage] = useState('');
  const [msg, setMsg] = useState<{ kind: 'error' | 'success'; text: string } | null>(null);
  const seasons = m.kind === 'show' ? m.seasons.filter((s) => s.seasonNumber > 0) : [];
  const episodes = season === '' ? 0 : (seasons.find((s) => s.seasonNumber === season)?.episodeCount ?? 0);

  const send = async () => {
    setMsg(null);
    try {
      const r = await api<{ duplicate?: boolean; autoFix?: string | null }>('/api/issues', {
        body: { kind: m.kind, tmdbId: m.tmdbId, type, season: season === '' ? null : season, episode: episode === '' ? null : episode, message: message.trim() || undefined },
      });
      setShow(false);
      setMessage('');
      setMsg({ kind: 'success', text: r.duplicate ? 'Someone already reported that. It’s on the list to fix.' : r.autoFix ? `Thanks. ${r.autoFix}` : 'Thanks. A manager will take a look, and you’ll hear when it’s fixed.' });
      await qc.invalidateQueries({ queryKey: ['title-issues', m.kind, m.tmdbId] });
    } catch (e) {
      setMsg({ kind: 'error', text: (e as Error).message });
    }
  };

  return (
    <>
      <button className="btn-secondary" onClick={() => setShow(true)}>
        Report a problem
      </button>
      {!!open.data?.length && (
        <Link to="/issues" className="self-center text-sm text-warning hover:underline">
          {open.data.length === 1 ? `Reported: ${open.data[0]!.label}${scopeOf(open.data[0]!)}` : `${open.data.length} problems reported`}
        </Link>
      )}
      {msg && <Alert kind={msg.kind}>{msg.text}</Alert>}
      {show && (
        <Modal title={`Report a problem with ${m.title}`} onClose={() => setShow(false)}>
          <div className="space-y-3">
            <label className="block">
              <span className="label">What's wrong?</span>
              <select className="input" value={type} onChange={(e) => setType(e.target.value)}>
                {TYPES.map(([v, l]) => (
                  <option key={v} value={v}>
                    {l}
                  </option>
                ))}
              </select>
            </label>
            {m.kind === 'show' && (
              <div className="flex gap-2">
                <label className="block flex-1">
                  <span className="label">Season</span>
                  <select className="input" value={season} onChange={(e) => (setSeason(e.target.value === '' ? '' : Number(e.target.value)), setEpisode(''))}>
                    <option value="">The whole show</option>
                    {seasons.map((s) => (
                      <option key={s.seasonNumber} value={s.seasonNumber}>
                        Season {s.seasonNumber}
                      </option>
                    ))}
                  </select>
                </label>
                {season !== '' && (
                  <label className="block flex-1">
                    <span className="label">Episode</span>
                    <select className="input" value={episode} onChange={(e) => setEpisode(e.target.value === '' ? '' : Number(e.target.value))}>
                      <option value="">Every episode</option>
                      {Array.from({ length: episodes }, (_, i) => i + 1).map((n) => (
                        <option key={n} value={n}>
                          Episode {n}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
              </div>
            )}
            <label className="block">
              <span className="label">{type === 'other' ? 'What happened?' : 'Anything else? (optional)'}</span>
              <textarea className="input min-h-20" maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} />
            </label>
            <button className="btn-primary" disabled={type === 'other' && !message.trim()} onClick={send}>
              Send report
            </button>
          </div>
        </Modal>
      )}
    </>
  );
}
