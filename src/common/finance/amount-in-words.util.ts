/**
 * Rupees in words, the way an Indian invoice states them.
 *
 * A tax invoice carries the amount twice — in figures and in words — so that a
 * altered figure is contradicted by the line beneath it. That means the Indian
 * numbering system (lakh, crore), not the short scale: ₹1,50,000 is "One Lakh
 * Fifty Thousand", never "One Hundred Fifty Thousand".
 *
 * Paise are stated separately when present, because "and fifty paise only" is
 * what the convention expects and dropping them makes the words disagree with
 * the figures.
 */
const ONES = [
  '', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine',
  'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen',
  'Seventeen', 'Eighteen', 'Nineteen',
];
const TENS = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];

/** 0–99 in words. */
function twoDigits(n: number): string {
  if (n < 20) return ONES[n];
  const tens = TENS[Math.floor(n / 10)];
  const ones = ONES[n % 10];
  return ones ? `${tens} ${ones}` : tens;
}

/** 0–999 in words. */
function threeDigits(n: number): string {
  const hundreds = Math.floor(n / 100);
  const rest = n % 100;
  if (!hundreds) return twoDigits(rest);
  const head = `${ONES[hundreds]} Hundred`;
  return rest ? `${head} ${twoDigits(rest)}` : head;
}

/**
 * A whole number of rupees in words, grouped the Indian way:
 * crore, lakh, thousand, then the last three digits.
 */
export function numberToIndianWords(value: number): string {
  const n = Math.floor(Math.abs(value));
  if (n === 0) return 'Zero';

  const crore = Math.floor(n / 10_000_000);
  const lakh = Math.floor((n % 10_000_000) / 100_000);
  const thousand = Math.floor((n % 100_000) / 1_000);
  const rest = n % 1_000;

  const parts: string[] = [];
  if (crore) parts.push(`${numberToIndianWords(crore)} Crore`);
  if (lakh) parts.push(`${twoDigits(lakh)} Lakh`);
  if (thousand) parts.push(`${twoDigits(thousand)} Thousand`);
  if (rest) parts.push(threeDigits(rest));
  return parts.join(' ');
}

/**
 * The full "Rupees … Only" line an invoice prints under its total.
 *
 * Rounds to the paisa first, so the words can never disagree with a figure
 * that was itself rounded for display.
 */
export function amountInWords(amount: number | string): string {
  const value = Math.round(Number(amount) * 100) / 100;
  if (!Number.isFinite(value)) return '';
  const negative = value < 0;
  const abs = Math.abs(value);
  const rupees = Math.floor(abs);
  const paise = Math.round((abs - rupees) * 100);

  // "Rupees Six Thousand Four Hundred and Paise Twelve Only" — the unit comes
  // before its number on the paise side, which is the usual convention and the
  // only way the line is unambiguous. Writing it as "...and Twelve Paise"
  // reads as though the whole preceding figure were paise.
  let words = `Rupees ${numberToIndianWords(rupees)}`;
  if (paise) words += ` and Paise ${twoDigits(paise)}`;
  words += ' Only';
  return negative ? `Minus ${words}` : words;
}
