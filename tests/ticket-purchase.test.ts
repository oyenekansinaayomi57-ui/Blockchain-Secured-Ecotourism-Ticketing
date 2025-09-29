import { describe, it, expect, beforeEach } from 'vitest';
import { Cl } from '@stacks/transactions';

const ERR_NOT_AUTHORIZED = 100;
const ERR_INVALID_ORG = 101;
const ERR_INSUFFICIENT_FUNDS = 102;
const ERR_TICKET_EXISTS = 103;
const ERR_INVALID_EVENT = 104;
const ERR_INVALID_AMOUNT = 105;
const ERR_TICKET_NOT_FOUND = 106;
const ERR_ALREADY_REDEEMED = 107;
const ERR_INVALID_TIMESTAMP = 108;
const ERR_ESCROW_NOT_SET = 109;
const ERR_INVALID_FEE = 110;
const ERR_INVALID_DISCOUNT = 111;
const ERR_NOT_ORGANIZER = 112;

interface Ticket {
  buyer: string;
  orgId: number;
  eventId: string;
  price: number;
  timestamp: number;
  redeemed: boolean;
  discountApplied: boolean;
}

interface Event {
  organizer: string;
  ticketPrice: number;
  totalTickets: number;
  availableTickets: number;
  active: boolean;
}

interface Result<T> {
  ok: boolean;
  value: T;
}

class TicketPurchaseMock {
  state: {
    ticketCounter: number;
    platformFee: number;
    escrowContract: string | null;
    discountRate: number;
    maxTicketsPerEvent: number;
    tickets: Map<number, Ticket>;
    events: Map<string, Event>;
  } = {
    ticketCounter: 0,
    platformFee: 1000,
    escrowContract: null,
    discountRate: 10,
    maxTicketsPerEvent: 1000,
    tickets: new Map(),
    events: new Map(),
  };
  blockHeight: number = 0;
  caller: string = 'ST1TEST';
  owner: string = 'ST1TEST';
  stxBalances: Map<string, number> = new Map([['ST1TEST', 1000000]]);
  stxTransfers: Array<{ amount: number; from: string; to: string }> = [];
  orgRegistry: Set<number> = new Set([1]);
  ticketNftMints: Array<{ ticketId: number; buyer: string; eventId: string }> = [];

  reset() {
    this.state = {
      ticketCounter: 0,
      platformFee: 1000,
      escrowContract: null,
      discountRate: 10,
      maxTicketsPerEvent: 1000,
      tickets: new Map(),
      events: new Map(),
    };
    this.blockHeight = 0;
    this.caller = 'ST1TEST';
    this.stxBalances = new Map([['ST1TEST', 1000000]]);
    this.stxTransfers = [];
    this.orgRegistry = new Set([1]);
    this.ticketNftMints = [];
  }

  isValidOrg(orgId: number): Result<boolean> {
    return { ok: true, value: this.orgRegistry.has(orgId) };
  }

  setEscrowContract(contractPrincipal: string): Result<boolean> {
    if (this.caller !== this.owner) return { ok: false, value: ERR_NOT_AUTHORIZED };
    this.state.escrowContract = contractPrincipal;
    return { ok: true, value: true };
  }

  setPlatformFee(newFee: number): Result<boolean> {
    if (this.caller !== this.owner) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (newFee < 0) return { ok: false, value: ERR_INVALID_FEE };
    this.state.platformFee = newFee;
    return { ok: true, value: true };
  }

  setDiscountRate(newRate: number): Result<boolean> {
    if (this.caller !== this.owner) return { ok: false, value: ERR_NOT_AUTHORIZED };
    if (newRate > 100) return { ok: false, value: ERR_INVALID_DISCOUNT };
    this.state.discountRate = newRate;
    return { ok: true, value: true };
  }

  createEvent(eventId: string, ticketPrice: number, totalTickets: number): Result<boolean> {
    if (!eventId || eventId.length > 32) return { ok: false, value: ERR_INVALID_EVENT };
    if (ticketPrice <= 0 || totalTickets <= 0 || totalTickets > this.state.maxTicketsPerEvent) {
      return { ok: false, value: ERR_INVALID_AMOUNT };
    }
    if (this.state.events.has(eventId)) return { ok: false, value: ERR_TICKET_EXISTS };
    this.state.events.set(eventId, {
      organizer: this.caller,
      ticketPrice,
      totalTickets,
      availableTickets: totalTickets,
      active: true,
    });
    return { ok: true, value: true };
  }

  buyTicket(orgId: number, eventId: string, applyDiscount: boolean): Result<number> {
    if (!this.state.escrowContract) return { ok: false, value: ERR_ESCROW_NOT_SET };
    if (!this.isValidOrg(orgId).value) return { ok: false, value: ERR_INVALID_ORG };
    const event = this.state.events.get(eventId);
    if (!event || !event.active || event.availableTickets <= 0) return { ok: false, value: ERR_INVALID_EVENT };
    if (event.ticketPrice <= 0) return { ok: false, value: ERR_INVALID_AMOUNT };
    const discount = applyDiscount ? this.state.discountRate : 0;
    const discountedPrice = Math.floor((event.ticketPrice * (100 - discount)) / 100);
    const totalPrice = discountedPrice + this.state.platformFee;
    const balance = this.stxBalances.get(this.caller) || 0;
    if (balance < totalPrice) return { ok: false, value: ERR_INSUFFICIENT_FUNDS };
    const ticketId = this.state.ticketCounter;
    this.stxBalances.set(this.caller, balance - totalPrice);
    this.stxTransfers.push({ amount: discountedPrice, from: this.caller, to: this.state.escrowContract });
    this.stxTransfers.push({ amount: this.state.platformFee, from: this.caller, to: this.owner });
    this.ticketNftMints.push({ ticketId, buyer: this.caller, eventId });
    this.state.tickets.set(ticketId, {
      buyer: this.caller,
      orgId,
      eventId,
      price: discountedPrice,
      timestamp: this.blockHeight,
      redeemed: false,
      discountApplied: applyDiscount,
    });
    this.state.events.set(eventId, { ...event, availableTickets: event.availableTickets - 1 });
    this.state.ticketCounter++;
    return { ok: true, value: ticketId };
  }

  redeemTicket(ticketId: number): Result<boolean> {
    const ticket = this.state.tickets.get(ticketId);
    if (!ticket) return { ok: false, value: ERR_TICKET_NOT_FOUND };
    const event = this.state.events.get(ticket.eventId);
    if (!event) return { ok: false, value: ERR_INVALID_EVENT };
    if (this.caller !== event.organizer) return { ok: false, value: ERR_NOT_ORGANIZER };
    if (ticket.redeemed) return { ok: false, value: ERR_ALREADY_REDEEMED };
    this.state.tickets.set(ticketId, { ...ticket, redeemed: true });
    return { ok: true, value: true };
  }

  getTicket(ticketId: number): Ticket | null {
    return this.state.tickets.get(ticketId) || null;
  }

  getEventDetails(eventId: string): Event | null {
    return this.state.events.get(eventId) || null;
  }

  getPlatformFee(): Result<number> {
    return { ok: true, value: this.state.platformFee };
  }

  getDiscountRate(): Result<number> {
    return { ok: true, value: this.state.discountRate };
  }

  getTicketCount(): Result<number> {
    return { ok: true, value: this.state.ticketCounter };
  }
}

describe('TicketPurchase', () => {
  let contract: TicketPurchaseMock;

  beforeEach(() => {
    contract = new TicketPurchaseMock();
    contract.reset();
  });

  it('creates an event successfully', () => {
    const result = contract.createEvent('event-1', 1000, 50);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    const event = contract.getEventDetails('event-1');
    expect(event).toEqual({
      organizer: 'ST1TEST',
      ticketPrice: 1000,
      totalTickets: 50,
      availableTickets: 50,
      active: true,
    });
  });

  it('rejects duplicate event creation', () => {
    contract.createEvent('event-1', 1000, 50);
    const result = contract.createEvent('event-1', 2000, 100);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_TICKET_EXISTS);
  });

  it('buys a ticket successfully with discount', () => {
    contract.setEscrowContract('ST2ESCROW');
    contract.createEvent('event-1', 1000, 50);
    const result = contract.buyTicket(1, 'event-1', true);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(0);
    const ticket = contract.getTicket(0);
    expect(ticket).toEqual({
      buyer: 'ST1TEST',
      orgId: 1,
      eventId: 'event-1',
      price: 900,
      timestamp: 0,
      redeemed: false,
      discountApplied: true,
    });
    expect(contract.stxTransfers).toEqual([
      { amount: 900, from: 'ST1TEST', to: 'ST2ESCROW' },
      { amount: 1000, from: 'ST1TEST', to: 'ST1TEST' },
    ]);
    expect(contract.ticketNftMints).toEqual([{ ticketId: 0, buyer: 'ST1TEST', eventId: 'event-1' }]);
    expect(contract.getEventDetails('event-1')?.availableTickets).toBe(49);
  });

  it('rejects ticket purchase without escrow contract', () => {
    contract.createEvent('event-1', 1000, 50);
    const result = contract.buyTicket(1, 'event-1', false);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ESCROW_NOT_SET);
  });

  it('rejects ticket purchase with insufficient funds', () => {
    contract.setEscrowContract('ST2ESCROW');
    contract.createEvent('event-1', 1000000, 50);
    contract.stxBalances.set('ST1TEST', 1000);
    const result = contract.buyTicket(1, 'event-1', false);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INSUFFICIENT_FUNDS);
  });

  it('rejects ticket purchase for invalid org', () => {
    contract.setEscrowContract('ST2ESCROW');
    contract.createEvent('event-1', 1000, 50);
    const result = contract.buyTicket(999, 'event-1', false);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_ORG);
  });

  it('redeems a ticket successfully', () => {
    contract.setEscrowContract('ST2ESCROW');
    contract.createEvent('event-1', 1000, 50);
    contract.buyTicket(1, 'event-1', false);
    const result = contract.redeemTicket(0);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getTicket(0)?.redeemed).toBe(true);
  });

  it('rejects redemption by non-organizer', () => {
    contract.setEscrowContract('ST2ESCROW');
    contract.createEvent('event-1', 1000, 50);
    contract.buyTicket(1, 'event-1', false);
    contract.caller = 'ST3FAKE';
    const result = contract.redeemTicket(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_NOT_ORGANIZER);
  });

  it('rejects redemption of already redeemed ticket', () => {
    contract.setEscrowContract('ST2ESCROW');
    contract.createEvent('event-1', 1000, 50);
    contract.buyTicket(1, 'event-1', false);
    contract.redeemTicket(0);
    const result = contract.redeemTicket(0);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_ALREADY_REDEEMED);
  });

  it('sets platform fee successfully', () => {
    const result = contract.setPlatformFee(2000);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getPlatformFee().value).toBe(2000);
  });

  it('sets discount rate successfully', () => {
    const result = contract.setDiscountRate(20);
    expect(result.ok).toBe(true);
    expect(result.value).toBe(true);
    expect(contract.getDiscountRate().value).toBe(20);
  });

  it('rejects invalid event id', () => {
    const longId = 'a'.repeat(33);
    const result = contract.createEvent(longId, 1000, 50);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_EVENT);
  });

  it('rejects invalid ticket price', () => {
    const result = contract.createEvent('event-1', 0, 50);
    expect(result.ok).toBe(false);
    expect(result.value).toBe(ERR_INVALID_AMOUNT);
  });
});