# Custom entries and messages in a session

Written by `entries.test.ts` from `src/entries.ts`. Do not edit by hand. A section that changes needs a new
`version` for its type in `src/entries.ts`; then run the test with `-u`. The table above the sections may change
without one.

| type | kind | written by | read by | what it is |
|---|---|---|---|---|
| `kyrn.board` | entry | src/extension/features/board.ts | - | The plain-language board after an update, so a reopened session shows it again. |
| `kyrn.capabilities` | message | src/extension/features/catalog.ts | - | Tells the model, after the first turn, which capabilities were opened for the request. |
| `kyrn.capability` | entry | src/extension/features/catalog.ts; src/extension/features/packs.ts | - | A capability opened, and who opened it: one the model had to ask for is the label the disclosure decision is measured by. |
| `kyrn.checkpoint` | entry | src/extension/features/checkpoint.ts | desktop: nativeHost/reducer.ts | A checkpoint taken before the first change of a user turn: the snapshot commit and the message it goes back to. |
| `kyrn.deadline` | message | src/extension/features/deadline.ts | - | How much of the run's time budget is left. |
| `kyrn.decision` | entry | src/extension/runtime.ts | desktop: nativeHost/reducer.ts; mu ledger: kyrn/bin/kyrn-ledger; /ledger: src/extension/features/commands.ts; replay: src/providers/replay.ts | One record of the judge's ledger: what a decision asked, the answers, what mu acted on. |
| `kyrn.diagnostics` | message | src/extension/features/lsp.ts | - | Errors the language servers found in what the agent changed. |
| `kyrn.forgetting.state` | entry | src/extension/features/forgetting.ts | - | Which tool outputs the model no longer reads, so a reopened session forgets the same ones. |
| `kyrn.frame` | entry | src/extension/features/frame.ts | - | The task frame: the goal, the user's constraints and the checklist. |
| `kyrn.frame` | message | src/extension/features/frame.ts | - | The task frame as the model reads it. |
| `kyrn.full-output` | entry | src/extension/full-output.ts | recall: src/extension/features/recall.ts | Where the whole of a tool output mu cut is kept, for recall to read the rest. |
| `kyrn.goal` | entry | src/extension/features/goal.ts | desktop: nativeHost/reducer.ts | The goal of the conversation and where it stands; the latest on the branch holds. |
| `kyrn.goal` | message | src/extension/features/goal.ts | - | Sends the agent back to work towards the goal, or tells it the goal is paused or met. |
| `kyrn.hint` | message | src/extension/features/preflight.ts | - | What the preflight verdict tells the model about the message: a side question, a plan first. |
| `kyrn.hive` | message | src/extension/features/hive.ts | - | What the hive passes to one of its bees while it works. |
| `kyrn.hive-request` | message | src/extension/features/hive.ts | - | What a `/hive` the user typed asks for, given to the model with that turn only. |
| `kyrn.interrupted` | message | src/extension/features/interrupted.ts | - | The text of a reply the user stopped, which pi leaves out of the next request, for the model only. |
| `kyrn.lessons` | message | src/extension/features/memory.ts | - | Lessons of this project that apply to the task. |
| `kyrn.monitor` | entry | src/extension/features/monitor.ts | - | What the drift check or the loop rule said, or in shadow mode would have said: the record a shadow run is judged by. |
| `kyrn.notice` | message | src/extension/features/notify.ts | - | An event the notify feature passes on to the model, now or with the next turn. |
| `kyrn.nudge` | message | src/extension/features/continuation.ts; src/extension/features/completion.ts | - | Sends a run that stopped short, or left a change unverified, back to work. |
| `kyrn.outcome` | entry | src/extension/features/permissions.ts; src/extension/features/commands.ts; src/extension/features/nudge-outcome.ts | desktop: nativeHost/reducer.ts; mu ledger: kyrn/bin/kyrn-ledger; /ledger: src/extension/features/commands.ts | What became of a judgment: the user's answer to the question it sent them, their mark that it was wrong, or what the agent did with the nudge it sent. |
| `kyrn.prefix` | entry | src/extension/features/prefix.ts | - | A request to the model that no longer starts with the one before it: what changed, and what mu decided in between. |
| `kyrn.question` | entry | src/extension/features/ask-user.ts | - | How questions the model asked with ask_user ended: answered, skipped or pending, and a late answer (kyrn/docs/features/ask-user.md). |
| `kyrn.recovery` | message | src/extension/features/recovery.ts | - | Which calls an interruption left without a result, and what to check before running them again. |
| `kyrn.rewind` | message | src/extension/features/checkpoint.ts | - | The lesson of a rewind, for the model to start over with. |
| `kyrn.rewound` | entry | src/extension/features/checkpoint.ts | - | A rewind that happened, with the snapshot that undoes it. |
| `kyrn.skills` | message | src/extension/features/skills.ts | - | The skills that apply to the task. |
| `kyrn.steer` | message | src/extension/features/checkpoint.ts; src/extension/features/monitor.ts | - | A short correction while the agent works: it loops or drifts, its approach looks like a dead end, or the files are back at a checkpoint. |
| `kyrn.subagent-session` | entry | src/extension/features/swarm.ts | - | Ties a sub-agent's own session file to the delegate or hive call that started it (kyrn/docs/features/subagent-sessions.md). |
| `kyrn.swarm` | message | src/extension/features/swarm-child.ts | - | Asks a sub-agent to wrap up and report. |
| `kyrn.tool-dispatch` | entry | src/extension/features/recovery.ts | - | A call that may change something started: after an interruption its outcome is unknown. |
| `kyrn.ttsr` | message | src/extension/features/ttsr.ts | - | Why a reply was cut while it broke one of the user's rules, and what to do instead. |
| `kyrn.usage` | entry | src/extension/features/swarm.ts; src/extension/features/watchdog.ts | usage totals: src/swarm/state.ts | Spend the session's own messages do not report: sub-agents, and a reply the watchdog cut. |
| `kyrn.verdict` | entry | src/extension/features/preflight.ts | desktop: nativeHost/reducer.ts | The preflight verdict on a user message, as the verdict line under it shows it. |
| `kyrn.watchdog` | message | src/extension/features/watchdog.ts | - | A reply that only thought too long was cut: where its reasoning got to, and to act on it. |
| `mu.import` | message | src/import/session.ts | - | The first message of a conversation brought in from another tool: where it came from. |
| `mu.import.context` | message | src/import/session.ts | - | What the imported conversation held that was not a message there, for the model only. |
| `mu.permissions` | entry | src/extension/features/permissions.ts | desktop: nativeHost/settings.ts | The conversation's permission mode after a switch; the latest on the branch holds when it is opened again. |

## kyrn.board v1

A entry. No schema: no other program reads it.

## kyrn.capabilities v1

A message. No schema: no other program reads it.

## kyrn.capability v1

A entry. No schema: no other program reads it.

## kyrn.checkpoint v1

A entry, read by another program:

```json
{
	"type": "object",
	"required": [
		"id",
		"turn",
		"commit",
		"label",
		"at"
	],
	"properties": {
		"id": {
			"type": "integer"
		},
		"turn": {
			"type": "number"
		},
		"commit": {
			"type": "string"
		},
		"entryId": {
			"type": "string"
		},
		"label": {
			"type": "string"
		},
		"at": {
			"type": "number"
		}
	}
}
```

## kyrn.deadline v1

A message. No schema: no other program reads it.

## kyrn.decision v1

A entry, read by another program:

```json
{
	"type": "object",
	"required": [
		"id",
		"timestamp",
		"specId",
		"specVersion",
		"mode",
		"providerId",
		"outcome",
		"source",
		"stateDigest"
	],
	"properties": {
		"id": {
			"type": "string"
		},
		"timestamp": {
			"type": "string"
		},
		"origin": {},
		"specId": {
			"type": "string"
		},
		"specVersion": {
			"type": "number"
		},
		"mode": {
			"anyOf": [
				{
					"type": "string",
					"const": "shadow"
				},
				{
					"type": "string",
					"const": "active"
				}
			]
		},
		"providerId": {
			"type": "string"
		},
		"modelId": {
			"type": "string"
		},
		"outcome": {},
		"source": {
			"anyOf": [
				{
					"type": "string",
					"const": "judge"
				},
				{
					"type": "string",
					"const": "fallback"
				}
			]
		},
		"reason": {
			"type": "string"
		},
		"judged": {},
		"answers": {
			"type": "object",
			"patternProperties": {
				"^.*$": {
					"anyOf": [
						{
							"type": "object",
							"required": [
								"type",
								"probability"
							],
							"properties": {
								"type": {
									"type": "string",
									"const": "boolean"
								},
								"probability": {
									"type": "number"
								},
								"confidence": {
									"type": "number"
								},
								"judge": {
									"type": "string"
								}
							}
						},
						{
							"type": "object",
							"required": [
								"type",
								"choice"
							],
							"properties": {
								"type": {
									"type": "string",
									"const": "choice"
								},
								"choice": {
									"type": "string"
								},
								"probabilities": {
									"type": "object",
									"patternProperties": {
										"^.*$": {
											"type": "number"
										}
									}
								},
								"confidence": {
									"type": "number"
								},
								"judge": {
									"type": "string"
								}
							}
						},
						{
							"type": "object",
							"required": [
								"type",
								"score"
							],
							"properties": {
								"type": {
									"type": "string",
									"const": "score"
								},
								"score": {
									"type": "number"
								},
								"probabilities": {
									"type": "object",
									"patternProperties": {
										"^.*$": {
											"type": "number"
										}
									}
								},
								"confidence": {
									"type": "number"
								},
								"judge": {
									"type": "string"
								}
							}
						}
					]
				}
			}
		},
		"latencyMs": {
			"type": "number"
		},
		"usage": {
			"type": "object",
			"properties": {
				"inputTokens": {
					"type": "number"
				},
				"outputTokens": {
					"type": "number"
				},
				"cachedInputTokens": {
					"type": "number"
				},
				"cacheWriteTokens": {
					"type": "number"
				}
			}
		},
		"warnings": {
			"type": "array",
			"items": {
				"type": "object",
				"required": [
					"type"
				],
				"properties": {
					"type": {
						"type": "string"
					},
					"message": {
						"type": "string"
					},
					"questionId": {
						"type": "string"
					}
				}
			}
		},
		"tiers": {
			"type": "array",
			"items": {
				"type": "object",
				"required": [
					"judgeId",
					"asked",
					"kept"
				],
				"properties": {
					"judgeId": {
						"type": "string"
					},
					"asked": {
						"type": "number"
					},
					"kept": {
						"type": "number"
					},
					"latencyMs": {
						"type": "number"
					},
					"error": {
						"type": "string"
					}
				}
			}
		},
		"batch": {
			"type": "object",
			"required": [
				"size",
				"failures"
			],
			"properties": {
				"size": {
					"type": "number"
				},
				"failures": {
					"type": "number"
				},
				"answers": {
					"type": "array",
					"items": {
						"anyOf": [
							{
								"type": "object",
								"patternProperties": {
									"^.*$": {
										"anyOf": [
											{
												"type": "object",
												"required": [
													"type",
													"probability"
												],
												"properties": {
													"type": {
														"type": "string",
														"const": "boolean"
													},
													"probability": {
														"type": "number"
													},
													"confidence": {
														"type": "number"
													},
													"judge": {
														"type": "string"
													}
												}
											},
											{
												"type": "object",
												"required": [
													"type",
													"choice"
												],
												"properties": {
													"type": {
														"type": "string",
														"const": "choice"
													},
													"choice": {
														"type": "string"
													},
													"probabilities": {
														"type": "object",
														"patternProperties": {
															"^.*$": {
																"type": "number"
															}
														}
													},
													"confidence": {
														"type": "number"
													},
													"judge": {
														"type": "string"
													}
												}
											},
											{
												"type": "object",
												"required": [
													"type",
													"score"
												],
												"properties": {
													"type": {
														"type": "string",
														"const": "score"
													},
													"score": {
														"type": "number"
													},
													"probabilities": {
														"type": "object",
														"patternProperties": {
															"^.*$": {
																"type": "number"
															}
														}
													},
													"confidence": {
														"type": "number"
													},
													"judge": {
														"type": "string"
													}
												}
											}
										]
									}
								}
							},
							{
								"type": "null"
							}
						]
					}
				},
				"digests": {
					"type": "array",
					"items": {
						"type": "string"
					}
				}
			}
		},
		"stateDigest": {
			"type": "string"
		},
		"state": {},
		"questions": {}
	}
}
```

## kyrn.diagnostics v1

A message. No schema: no other program reads it.

## kyrn.forgetting.state v1

A entry. No schema: no other program reads it.

## kyrn.frame v1

A entry. No schema: no other program reads it.

## kyrn.frame v1

A message. No schema: no other program reads it.

## kyrn.full-output v1

A entry. No schema: no other program reads it.

## kyrn.goal v1

A entry, read by another program:

```json
{
	"type": "object",
	"required": [
		"status",
		"text",
		"continuations"
	],
	"properties": {
		"status": {
			"anyOf": [
				{
					"type": "string",
					"const": "active"
				},
				{
					"type": "string",
					"const": "paused"
				},
				{
					"type": "string",
					"const": "met"
				},
				{
					"type": "string",
					"const": "cleared"
				}
			]
		},
		"text": {
			"type": "string"
		},
		"reason": {
			"type": "string"
		},
		"reasonCode": {
			"type": "string"
		},
		"reasonParams": {
			"type": "object",
			"patternProperties": {
				"^.*$": {
					"anyOf": [
						{
							"type": "string"
						},
						{
							"type": "number"
						}
					]
				}
			}
		},
		"continuations": {
			"type": "number"
		},
		"next": {
			"type": "string"
		},
		"checkedBy": {
			"anyOf": [
				{
					"type": "string",
					"const": "model"
				},
				{
					"type": "string",
					"const": "jev"
				},
				{
					"type": "string",
					"const": "rules"
				}
			]
		}
	}
}
```

## kyrn.goal v1

A message. No schema: no other program reads it.

## kyrn.hint v1

A message. No schema: no other program reads it.

## kyrn.hive v1

A message. No schema: no other program reads it.

## kyrn.hive-request v1

A message. No schema: no other program reads it.

## kyrn.interrupted v1

A message. No schema: no other program reads it.

## kyrn.lessons v1

A message. No schema: no other program reads it.

## kyrn.monitor v1

A entry, read by another program:

```json
{
	"anyOf": [
		{
			"type": "object",
			"required": [
				"kind",
				"judged",
				"content"
			],
			"properties": {
				"kind": {
					"anyOf": [
						{
							"type": "string",
							"const": "drift"
						},
						{
							"type": "string",
							"const": "loop"
						}
					]
				},
				"judged": {
					"type": "boolean",
					"const": true
				},
				"shadow": {
					"type": "boolean",
					"const": true
				},
				"content": {
					"type": "string"
				}
			}
		},
		{
			"type": "object",
			"required": [
				"kind",
				"action",
				"times"
			],
			"properties": {
				"kind": {
					"type": "string",
					"const": "loop"
				},
				"action": {
					"type": "string"
				},
				"times": {
					"type": "number"
				},
				"refused": {
					"type": "boolean",
					"const": true
				}
			}
		}
	]
}
```

## kyrn.notice v1

A message. No schema: no other program reads it.

## kyrn.nudge v1

A message. No schema: no other program reads it.

## kyrn.outcome v2

A entry, read by another program:

```json
{
	"anyOf": [
		{
			"type": "object",
			"required": [
				"kind",
				"toolCallId",
				"tool",
				"mode",
				"reason",
				"answer",
				"waitedMs"
			],
			"properties": {
				"kind": {
					"type": "string",
					"const": "permission"
				},
				"toolCallId": {
					"type": "string"
				},
				"tool": {
					"type": "string"
				},
				"mode": {
					"anyOf": [
						{
							"type": "string",
							"const": "full"
						},
						{
							"type": "string",
							"const": "judge"
						},
						{
							"type": "string",
							"const": "ask"
						}
					]
				},
				"reason": {
					"anyOf": [
						{
							"type": "string",
							"const": "ask"
						},
						{
							"type": "string",
							"const": "unsure"
						},
						{
							"type": "string",
							"const": "beyond"
						},
						{
							"type": "string",
							"const": "unrelated"
						},
						{
							"type": "string",
							"const": "flagged"
						},
						{
							"type": "string",
							"const": "protected"
						},
						{
							"type": "string",
							"const": "nojudge"
						},
						{
							"type": "string",
							"const": "judgedown"
						},
						{
							"type": "string",
							"const": "long"
						}
					]
				},
				"flagCode": {
					"type": "string"
				},
				"ledgerId": {
					"type": "string"
				},
				"specId": {
					"type": "string"
				},
				"judged": {},
				"answer": {
					"anyOf": [
						{
							"type": "string",
							"const": "once"
						},
						{
							"type": "string",
							"const": "session"
						},
						{
							"type": "string",
							"const": "deny"
						},
						{
							"type": "string",
							"const": "dismissed"
						},
						{
							"type": "string",
							"const": "none"
						}
					]
				},
				"grant": {
					"type": "string"
				},
				"waitedMs": {
					"type": "number"
				},
				"outsideFloor": {
					"type": "boolean",
					"const": true
				}
			}
		},
		{
			"type": "object",
			"required": [
				"kind",
				"ledgerId",
				"specId",
				"specVersion",
				"mark"
			],
			"properties": {
				"kind": {
					"type": "string",
					"const": "mark"
				},
				"ledgerId": {
					"type": "string"
				},
				"specId": {
					"type": "string"
				},
				"specVersion": {
					"type": "number"
				},
				"judged": {},
				"mark": {
					"type": "string",
					"const": "wrong"
				},
				"note": {
					"type": "string"
				}
			}
		},
		{
			"type": "object",
			"required": [
				"kind",
				"ledgerId",
				"specId",
				"followed",
				"calls"
			],
			"properties": {
				"kind": {
					"type": "string",
					"const": "followed"
				},
				"ledgerId": {
					"type": "string"
				},
				"specId": {
					"type": "string"
				},
				"judged": {},
				"followed": {
					"anyOf": [
						{
							"type": "string",
							"const": "acted"
						},
						{
							"type": "string",
							"const": "ended"
						}
					]
				},
				"calls": {
					"type": "number"
				}
			}
		}
	]
}
```

## kyrn.prefix v1

A entry. No schema: no other program reads it.

## kyrn.question v1

A entry. No schema: no other program reads it.

## kyrn.recovery v1

A message. No schema: no other program reads it.

## kyrn.rewind v1

A message. No schema: no other program reads it.

## kyrn.rewound v1

A entry. No schema: no other program reads it.

## kyrn.skills v1

A message. No schema: no other program reads it.

## kyrn.steer v1

A message. No schema: no other program reads it.

## kyrn.subagent-session v1

A entry, read by another program:

```json
{
	"type": "object",
	"required": [
		"toolCallId",
		"kind",
		"name",
		"session"
	],
	"properties": {
		"toolCallId": {
			"type": "string"
		},
		"kind": {
			"anyOf": [
				{
					"type": "string",
					"const": "delegate"
				},
				{
					"type": "string",
					"const": "hive"
				}
			]
		},
		"name": {
			"type": "string"
		},
		"session": {
			"type": "string"
		}
	}
}
```

## kyrn.swarm v1

A message. No schema: no other program reads it.

## kyrn.tool-dispatch v1

A entry. No schema: no other program reads it.

## kyrn.ttsr v1

A message. No schema: no other program reads it.

## kyrn.usage v1

A entry. No schema: no other program reads it.

## kyrn.verdict v1

A entry, read by another program:

```json
{
	"type": "object",
	"required": [
		"version",
		"by",
		"state",
		"turnType",
		"gear",
		"hints",
		"answers"
	],
	"properties": {
		"version": {
			"type": "number",
			"const": 1
		},
		"by": {
			"type": "string"
		},
		"state": {
			"anyOf": [
				{
					"type": "string",
					"const": "applied"
				},
				{
					"type": "string",
					"const": "shadow"
				},
				{
					"type": "string",
					"const": "late"
				},
				{
					"type": "string",
					"const": "none"
				}
			]
		},
		"turnType": {
			"type": "string"
		},
		"gear": {
			"anyOf": [
				{
					"type": "string",
					"const": "chat"
				},
				{
					"type": "string",
					"const": "light"
				},
				{
					"type": "string",
					"const": "standard"
				},
				{
					"type": "string",
					"const": "heavy"
				}
			]
		},
		"latencyMs": {
			"type": "number"
		},
		"reason": {
			"type": "string"
		},
		"reasonCode": {
			"type": "string"
		},
		"reasonParams": {
			"type": "object",
			"patternProperties": {
				"^.*$": {
					"type": "number"
				}
			}
		},
		"thinking": {
			"type": "object",
			"required": [
				"from",
				"to"
			],
			"properties": {
				"from": {
					"type": "string"
				},
				"to": {
					"type": "string"
				}
			}
		},
		"hints": {
			"type": "array",
			"items": {
				"type": "string"
			}
		},
		"hintIds": {
			"type": "array",
			"items": {
				"type": "string"
			}
		},
		"answers": {
			"type": "array",
			"items": {
				"type": "array",
				"additionalItems": false,
				"items": [
					{
						"type": "string"
					},
					{
						"type": "string"
					}
				],
				"minItems": 2
			}
		},
		"answerValues": {
			"type": "object",
			"patternProperties": {
				"^.*$": {
					"anyOf": [
						{
							"type": "object",
							"required": [
								"type",
								"probability"
							],
							"properties": {
								"type": {
									"type": "string",
									"const": "boolean"
								},
								"probability": {
									"type": "number"
								},
								"confidence": {
									"type": "number"
								},
								"judge": {
									"type": "string"
								}
							}
						},
						{
							"type": "object",
							"required": [
								"type",
								"choice"
							],
							"properties": {
								"type": {
									"type": "string",
									"const": "choice"
								},
								"choice": {
									"type": "string"
								},
								"probabilities": {
									"type": "object",
									"patternProperties": {
										"^.*$": {
											"type": "number"
										}
									}
								},
								"confidence": {
									"type": "number"
								},
								"judge": {
									"type": "string"
								}
							}
						},
						{
							"type": "object",
							"required": [
								"type",
								"score"
							],
							"properties": {
								"type": {
									"type": "string",
									"const": "score"
								},
								"score": {
									"type": "number"
								},
								"probabilities": {
									"type": "object",
									"patternProperties": {
										"^.*$": {
											"type": "number"
										}
									}
								},
								"confidence": {
									"type": "number"
								},
								"judge": {
									"type": "string"
								}
							}
						}
					]
				}
			}
		}
	}
}
```

## kyrn.watchdog v1

A message. No schema: no other program reads it.

## mu.import v1

A message. No schema: no other program reads it.

## mu.import.context v1

A message. No schema: no other program reads it.

## mu.permissions v1

A entry, read by another program:

```json
{
	"type": "object",
	"required": [
		"mode"
	],
	"properties": {
		"mode": {
			"anyOf": [
				{
					"type": "string",
					"const": "full"
				},
				{
					"type": "string",
					"const": "judge"
				},
				{
					"type": "string",
					"const": "ask"
				}
			]
		}
	}
}
```
