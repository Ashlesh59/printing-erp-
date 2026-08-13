const FormulaEngine = {
    evaluate: (formulaStr, context = { pages: 1, copies: 1 }) => {
        try {
            // Clean and normalize
            let clean = formulaStr.toLowerCase().trim();
            
            // Replace variables
            clean = clean.replace(/\bpages\b/g, String(context.pages || 0));
            clean = clean.replace(/\bcopies\b/g, String(context.copies || 0));
            
            const tokens = [];
            let i = 0;
            while (i < clean.length) {
                const char = clean[i];
                if (/\s/.test(char)) {
                    i++;
                    continue;
                }
                if (/[0-9.]/.test(char)) {
                    let num = '';
                    while (i < clean.length && /[0-9.]/.test(clean[i])) {
                        num += clean[i];
                        i++;
                    }
                    tokens.push({ type: 'NUMBER', value: parseFloat(num) });
                    continue;
                }
                if (/[a-z]/.test(char)) {
                    let word = '';
                    while (i < clean.length && /[a-z]/.test(clean[i])) {
                        word += clean[i];
                        i++;
                    }
                    if (['ceil', 'floor', 'round'].includes(word)) {
                        tokens.push({ type: 'FUNCTION', value: word });
                    } else {
                        throw new Error(`Unsupported identifier: ${word}`);
                    }
                    continue;
                }
                if (['+', '-', '*', '/', '%', '(', ')'].includes(char)) {
                    tokens.push({ type: 'OPERATOR', value: char });
                    i++;
                    continue;
                }
                throw new Error(`Invalid character in formula: ${char}`);
            }

            let tokenIndex = 0;
            function peek() {
                return tokens[tokenIndex];
            }
            function consume(type) {
                const tok = peek();
                if (!tok || (type && tok.type !== type)) {
                    throw new Error(`Expected token of type ${type}`);
                }
                tokenIndex++;
                return tok;
            }

            function parseExpr() {
                let val = parseTerm();
                while (peek() && peek().type === 'OPERATOR' && ['+', '-'].includes(peek().value)) {
                    const op = consume().value;
                    const right = parseTerm();
                    if (op === '+') val += right;
                    else val -= right;
                }
                return val;
            }

            function parseTerm() {
                let val = parseFactor();
                while (peek() && peek().type === 'OPERATOR' && ['*', '/', '%'].includes(peek().value)) {
                    const op = consume().value;
                    const right = parseFactor();
                    if (op === '*') val *= right;
                    else if (op === '/') val /= right;
                    else val %= right;
                }
                return val;
            }

            function parseFactor() {
                const tok = peek();
                if (!tok) throw new Error("Unexpected end of expression");

                if (tok.type === 'NUMBER') {
                    return consume().value;
                }
                if (tok.type === 'OPERATOR' && tok.value === '-') {
                    consume();
                    return -parseFactor();
                }
                if (tok.type === 'OPERATOR' && tok.value === '(') {
                    consume();
                    const val = parseExpr();
                    consume('OPERATOR'); // should be ')'
                    return val;
                }
                if (tok.type === 'FUNCTION') {
                    const funcName = consume().value;
                    consume('OPERATOR'); // should be '('
                    const val = parseExpr();
                    consume('OPERATOR'); // should be ')'
                    if (funcName === 'ceil') return Math.ceil(val);
                    if (funcName === 'floor') return Math.floor(val);
                    if (funcName === 'round') return Math.round(val);
                }
                throw new Error(`Unexpected token: ${tok.value}`);
            }

            return parseExpr();
        } catch (e) {
            console.error(`Formula parse error for "${formulaStr}":`, e);
            return 0;
        }
    }
};

module.exports = FormulaEngine;
