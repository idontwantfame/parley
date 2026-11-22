import ReactMarkdown from 'react-markdown';

const styles = 'space-y-2 [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_ul]:ml-5 [&_ul]:list-disc [&_ol]:ml-5 [&_ol]:list-decimal [&_li>ul]:mt-1 [&_li>ol]:mt-1 [&_code]:rounded [&_code]:bg-surface-3 [&_code]:px-1 [&_pre]:overflow-x-auto [&_a]:text-primary [&_a]:underline';

export default function Markdown({ text, className = '' }) {
  return (
    <div className={`${styles} ${className}`}>
      <ReactMarkdown skipHtml disallowedElements={['img']}>{String(text ?? '')}</ReactMarkdown>
    </div>
  );
}
