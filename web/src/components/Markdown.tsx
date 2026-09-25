import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { cx } from '../lib/utils';

export function Markdown({ text, className }: { text: string; className?: string }) {
  return (
    <div className={cx('md-body', className)}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{text}</ReactMarkdown>
    </div>
  );
}
