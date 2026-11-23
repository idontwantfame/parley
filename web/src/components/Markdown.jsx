import ReactMarkdown from 'react-markdown';

const styles = 'space-y-2 [&_h1]:font-bold [&_h2]:font-bold [&_h3]:font-semibold [&_ul]:ml-5 [&_ul]:list-disc [&_ol]:ml-5 [&_ol]:list-decimal [&_li>ul]:mt-1 [&_li>ol]:mt-1 [&_code]:rounded [&_code]:bg-surface-3 [&_code]:px-1 [&_pre]:overflow-x-auto [&_a]:text-primary [&_a]:underline';

// The text is LLM output derived from what people said, so a link in it is
// untrusted: open it in a new tab, without referrer or window.opener access,
// and don't lend it this page's reputation. (react-markdown's default URL
// transform still strips javascript: and other unsafe schemes.)
function ExternalLink({ node: _node, ...props }) {
  return <a {...props} target="_blank" rel="noopener noreferrer nofollow" />;
}

const COMPONENTS = { a: ExternalLink };

export default function Markdown({ text, className = '' }) {
  return (
    <div className={`${styles} ${className}`}>
      <ReactMarkdown skipHtml disallowedElements={['img']} components={COMPONENTS}>{String(text ?? '')}</ReactMarkdown>
    </div>
  );
}
