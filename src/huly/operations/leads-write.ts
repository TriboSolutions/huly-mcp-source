/**
 * Lead write operations.
 *
 * Mirrors Huly's native lead creation flow:
 * - increment the lead sequence
 * - ensure the attached organization has the Customer mixin
 * - create the lead as a Customer.leads collection item
 *
 * @module
 */
import type { Organization as HulyOrganization, Person } from "@hcengineering/contact"
import {
  type AttachedData,
  type AttachedDoc,
  type Doc,
  type DocumentUpdate,
  generateId,
  type MarkupBlobRef,
  type Ref,
  type Sequence,
  type Status
} from "@hcengineering/core"
import { Effect, Option, Schema } from "effect"

import type { CreateLeadParams, CreateLeadResult } from "../../domain/schemas/leads.js"
import { FunnelIdentifier, LeadIdentifier } from "../../domain/schemas/leads.js"
import { DocId } from "../../domain/schemas/shared.js"
import { HulyClient, type HulyClientError } from "../client.js"
import type { Diagnostics } from "../diagnostics.js"
import type { FunnelNotFoundError } from "../errors-leads.js"
import type {
  InvalidStatusError,
  OrganizationIdentifierAmbiguousError,
  OrganizationNotFoundError,
  PersonIdentifierAmbiguousError
} from "../errors.js"
import { HulyConnectionError } from "../errors.js"
import { contact, core } from "../huly-plugins.js"
import { leadClassIds } from "../lead-plugin.js"
import { findPersonByEmailOrName } from "./contacts-shared.js"
import { findFunnel, funnelAsSpace, getFunnelStatuses, resolveStatusByName } from "./leads.js"
import { resolveOrganizationByIdentifier } from "./organization-resolvers.js"
import { hulyQuery } from "./query-helpers.js"

interface HulyLead extends AttachedDoc {
  title: string
  identifier: string
  number: number
  status: Ref<Status>
  assignee: Ref<Person> | null
  description: MarkupBlobRef | null
  kind: Ref<Doc>
  rank: string
  startDate: number | null
  dueDate: number | null
  parents: ReadonlyArray<{ parentId: Ref<Doc>; identifier: string; parentTitle: string }>
}

type CreateLeadError =
  | HulyClientError
  | FunnelNotFoundError
  | HulyConnectionError
  | InvalidStatusError
  | OrganizationIdentifierAmbiguousError
  | OrganizationNotFoundError
  | PersonIdentifierAmbiguousError

const TxIncResult = Schema.Struct({
  object: Schema.Struct({ sequence: Schema.Number })
})

const extractUpdatedSequence = (txResult: unknown): number | undefined => {
  const decoded = Schema.decodeUnknownOption(TxIncResult)(txResult)
  return decoded._tag === "Some" ? decoded.value.object.sequence : undefined
}

const getNextLeadNumber = (
  client: HulyClient["Type"]
): Effect.Effect<number, HulyClientError | HulyConnectionError> =>
  Effect.gen(function*() {
    const sequence = yield* client.findOne<Sequence>(
      core.class.Sequence,
      hulyQuery<Sequence>({ attachedTo: leadClassIds.class.Lead })
    )
    if (sequence === undefined) {
      return yield* new HulyConnectionError({ message: "Huly lead sequence is missing" })
    }

    const update: DocumentUpdate<Sequence> = { $inc: { sequence: 1 } }
    const updated = yield* client.updateDoc(core.class.Sequence, sequence.space, sequence._id, update, true)
    const number = extractUpdatedSequence(updated)
    if (number === undefined) {
      return yield* new HulyConnectionError({
        message: "Unable to allocate a lead number from lead:sequence:Lead"
      })
    }
    return number
  })

const resolveLeadStatus = (
  params: CreateLeadParams,
  statuses: ReadonlyArray<{ _id: Ref<Status>; name: string }>
): Effect.Effect<Ref<Status>, InvalidStatusError | HulyConnectionError> => {
  if (params.status !== undefined) {
    return resolveStatusByName(statuses, params.status, params.funnel)
  }

  const defaultStatus = statuses.at(0)
  return defaultStatus !== undefined
    ? Effect.succeed(defaultStatus._id)
    : Effect.fail(new HulyConnectionError({ message: `Funnel '${params.funnel}' has no statuses` }))
}

const resolveAssignee = (
  client: HulyClient["Type"],
  assignee: CreateLeadParams["assignee"]
): Effect.Effect<Ref<Person> | null, HulyClientError | PersonIdentifierAmbiguousError> =>
  assignee === undefined
    ? Effect.succeed(null)
    : Effect.map(findPersonByEmailOrName(client, assignee), (person) => person?._id ?? null)

const ensureOrganizationCustomer = (
  client: HulyClient["Type"],
  organization: HulyOrganization
): Effect.Effect<void, HulyClientError> =>
  Object.prototype.hasOwnProperty.call(organization, leadClassIds.mixin.Customer)
    ? Effect.void
    : client.createMixin(
      organization._id,
      contact.class.Organization,
      contact.space.Contacts,
      leadClassIds.mixin.Customer,
      {}
    )

export const createLead = (
  params: CreateLeadParams
): Effect.Effect<CreateLeadResult, CreateLeadError, HulyClient | Diagnostics> =>
  Effect.gen(function*() {
    const client = yield* HulyClient
    const funnel = yield* findFunnel(client, params.funnel)
    const statuses = yield* getFunnelStatuses(client, funnel)
    const status = yield* resolveLeadStatus(params, statuses)
    const customer = yield* resolveOrganizationByIdentifier(client, params.customer)
    const assignee = yield* resolveAssignee(client, params.assignee)
    const number = yield* getNextLeadNumber(client)
    const identifier = `LEAD-${number}`
    const leadId = generateId<HulyLead>()

    yield* ensureOrganizationCustomer(client, customer)

    const description = yield* Option.match(Option.fromNullable(params.description), {
      onNone: () => Effect.succeed(null),
      onSome: (markdown) => client.uploadMarkup(leadClassIds.class.Lead, leadId, "description", markdown, "markdown")
    })

    const value: AttachedData<HulyLead> = {
      title: params.title,
      identifier,
      number,
      status,
      assignee,
      description,
      kind: leadClassIds.taskType.Lead,
      rank: "",
      startDate: null,
      dueDate: null,
      parents: []
    }

    yield* client.addCollection(
      leadClassIds.class.Lead,
      funnelAsSpace(funnel),
      customer._id,
      leadClassIds.mixin.Customer,
      "leads",
      value,
      leadId
    )

    return {
      identifier: Schema.decodeUnknownSync(LeadIdentifier)(identifier),
      leadId: DocId.make(leadId),
      title: params.title,
      funnel: FunnelIdentifier.make(funnel._id),
      funnelName: funnel.name,
      customer: customer.name
    }
  })
