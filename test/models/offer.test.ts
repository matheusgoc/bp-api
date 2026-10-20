import { isOfferVisible, offerStatus, OfferStatus } from '../../src/models/offer';
import { makeOffer } from '../handlers/offers/fixtures';

const now = new Date('2026-10-07T12:00:00.000Z');
const at = (offsetMs: number) => new Date(now.getTime() + offsetMs).toISOString();

describe('offerStatus', () => {
  it.each([
    ['active with no end', makeOffer({ end: '' }), OfferStatus.ACTIVE],
    ['active ending later', makeOffer({ end: at(1) }), OfferStatus.ACTIVE],
    ['active ending exactly now', makeOffer({ end: now.toISOString() }), OfferStatus.EXPIRED],
    ['active already ended', makeOffer({ end: at(-1) }), OfferStatus.EXPIRED],
    ['canceled after its end', makeOffer({ status: OfferStatus.CANCELED, end: at(-1) }), OfferStatus.CANCELED],
    ['active not started yet', makeOffer({ start: at(1) }), OfferStatus.ACTIVE],
  ])('%s', (_, item, expected) => {
    expect(offerStatus(item, now)).toBe(expected);
  });
});

describe('isOfferVisible', () => {
  it.each([
    ['active with no dates', makeOffer(), true],
    ['started exactly now', makeOffer({ start: now.toISOString() }), true],
    ['within its window', makeOffer({ start: at(-1), end: at(1) }), true],
    ['not started yet', makeOffer({ start: at(1) }), false],
    ['ending exactly now', makeOffer({ end: now.toISOString() }), false],
    ['canceled', makeOffer({ status: OfferStatus.CANCELED }), false],
  ])('%s', (_, item, expected) => {
    expect(isOfferVisible(item, now)).toBe(expected);
  });
});
