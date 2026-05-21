# Little Quest PRD

## 1. Product Summary

Little Quest is a web-based, parent-led AI learning companion for preschool children who are new to screens. The app turns early learning into short, physical-world quests: counting objects in the room, finding letter sounds, building patterns with blocks, solving story math, and giving movement commands to a toy "robot."

The product's core stance is that the screen is a prompt card and parent console, not the main play object. AI acts as a playful quest generator, narrator, and adaptive lesson planner while the parent remains the guide, interpreter, and safety layer.

## 2. Target Users

### Primary User

Parent or caregiver of a 3.5-6 year old child.

Needs:

- Introduce AI and technology gradually.
- Make learning feel joyful, physical, and conversational.
- Avoid passive screen consumption.
- Personalize lessons to the child's interests and current skill level.
- Trust that the app will not expose the child to open-ended unsafe AI behavior.

### Secondary User

Gifted or highly curious preschool child.

Needs:

- Short, playful challenges.
- Voice-first interaction.
- Real objects, movement, imagination, and adult attention.
- A feeling of agency without complex navigation.

## 3. Guiding Principles

- Parent-led by default: the parent starts, configures, approves, and ends sessions.
- Physical-world first: every game should make the child touch, move, sort, count, draw, speak, build, or pretend.
- One mission at a time: the child-facing UI should never feel like a dashboard.
- Short sessions: default sessions are 5-10 minutes.
- Calm reward design: use warmth, narration, and visible progress instead of streaks, coins, loot boxes, or endless loops.
- AI as scaffold: AI generates prompts, adapts difficulty, and summarizes learning, but it does not replace parent teaching.
- Privacy by design: no child account required for MVP; no stored audio/video by default.

## 4. Goals

### Learning Goals

- Counting: one-to-one correspondence, cardinality, comparing quantities, simple addition/subtraction.
- Literacy: letter recognition, letter sounds, rhyming, vocabulary, storytelling.
- Math reasoning: patterns, sorting, shapes, measurement, sequencing.
- Computational thinking: commands, debugging, cause/effect, step-by-step instructions.
- Metacognition: "How did you know?", "Can you try another way?", "What changed?"
- Social-emotional learning: patience, turn-taking, confidence, handling mistakes.

### Product Goals

- Let a parent start a high-quality learning game in under 30 seconds.
- Keep the child-facing screen readable from 3-6 feet away.
- Support voice narration for every mission.
- Allow generic AI provider selection for reasoning, voice, vision, and image generation.
- Provide a parent recap after each session with observed skills and suggested next lessons.

### Business/Product Goals

- MVP can be built as a standalone responsive web app/PWA.
- Architecture supports future native wrappers without rewriting game logic.
- AI model choice is configurable at deploy time and, later, in parent/admin settings.
- Child safety, privacy, and explainability are first-class product features.

## 5. Non-Goals

- No unsupervised child chatbot in MVP.
- No social features, leaderboards, or public sharing in MVP.
- No ads or third-party behavioral tracking.
- No child profile photo, child voiceprint, or biometric identity.
- No diagnosis, therapy, or claims about giftedness, developmental delay, or medical outcomes.
- No long-form passive video lessons.

## 6. Platform

### MVP Platform

- Web app built with Next.js or another React-based framework.
- Installable PWA for iPad, Android tablet, laptop, or parent phone.
- Responsive layout optimized for:
  - Parent phone in hand.
  - Tablet propped up on table.
  - Laptop/desktop for living-room play.

### Suggested Technical Stack

- Frontend: Next.js App Router, React, TypeScript.
- UI: Tailwind CSS plus a small component system.
- AI orchestration: Vercel AI SDK `ai` package for provider-agnostic text/structured generation where supported.
- State: local React state for active sessions; database only for opted-in parent history.
- Persistence: local-first for MVP; optional server database later.
- Auth: optional parent email login after MVP; no child login.
- Deployment: Vercel, Fly.io, or any Node-compatible platform.

## 7. AI Architecture

### Core Requirement

AI must be provider-generic. The app should not hardcode a single reasoning, voice, vision, or image provider.

### AI Capabilities

1. Reasoning model
   - Generates missions.
   - Adapts difficulty.
   - Produces structured lesson plans.
   - Writes parent summaries.

2. Voice input
   - Optional child/parent speech-to-text.
   - Parent can disable microphone completely.
   - MVP may use parent-entered answers instead of child speech.

3. Voice output
   - Reads missions aloud.
   - Uses calm, short phrasing.
   - Supports browser speech synthesis as a fallback.

4. Vision
   - Optional later feature where parent snaps a photo of blocks/cards/objects.
   - Used for low-stakes recognition only.
   - Always confirms with parent before treating vision output as correct.

5. Image generation
   - Optional later feature for custom story cards or printable mission sheets.
   - Never required for core gameplay.

### Provider Abstraction

Use AI SDK for provider-agnostic text and structured outputs. Wrap other modalities behind internal provider interfaces so the product can use AI SDK-compatible providers where available and direct provider adapters where needed.

Example configuration:

```env
AI_REASONING_PROVIDER=vercel-gateway
AI_REASONING_MODEL=openai/gpt-5.4-mini

AI_VOICE_TTS_PROVIDER=browser
AI_VOICE_TTS_MODEL=system-default

AI_VOICE_STT_PROVIDER=none
AI_VISION_PROVIDER=none
AI_IMAGE_PROVIDER=none
```

Example interfaces:

```ts
type QuestContext = {
  childAgeMonths: number;
  skill: SkillArea;
  level: LevelId;
  theme: ThemeId;
  availableMaterials: string[];
  sessionLengthMinutes: number;
  parentNotes?: string;
};

type Mission = {
  id: string;
  spokenPrompt: string;
  parentPrompt: string;
  expectedResponseType: "count" | "choice" | "object" | "movement" | "open";
  targetSkill: SkillArea;
  difficulty: 1 | 2 | 3 | 4 | 5;
  safetyFlags: string[];
  successCriteria: string[];
  hint: string;
  extension?: string;
};

interface ReasoningProvider {
  generateMissions(context: QuestContext): Promise<Mission[]>;
  adaptMission(input: AdaptationInput): Promise<Mission>;
  summarizeSession(session: SessionRecord): Promise<ParentSummary>;
}

interface SpeechProvider {
  speak(text: string, options: SpeechOptions): Promise<void>;
  transcribe?(audio: Blob): Promise<string>;
}

interface VisionProvider {
  describeImage?(image: Blob, prompt: string): Promise<VisionObservation>;
}
```

### AI Safety Rules

- All model outputs must be constrained to a schema.
- Prompts must be generated for preschool learning only.
- The AI must not ask the child for name, address, school, exact location, photos of face, or other personal data.
- The AI must not continue indefinitely; the session engine owns pacing and stopping.
- The AI should generate parent-facing suggestions, not direct behavioral judgments about the child.
- If uncertain, the app asks the parent to verify.

## 8. Product Experience

### Information Architecture

1. Parent Home
2. Start Quest
3. Game Selection
4. Session Setup
5. Active Mission
6. Parent Checkpoint
7. Session Recap
8. Parent Dashboard
9. Settings

### Parent Home

Purpose: start quickly.

Content:

- "Start a Quest" primary action.
- Recent games.
- Suggested next lesson.
- Screen-time/session setting.
- Parent settings access.

Example:

```text
Little Quest

Today's idea: Count treasures around the room

[Start Quest]

Games
[Treasure Hunt] [Letter Detective] [Math Story] [Pattern Robot]
```

### Session Setup

Parent chooses:

- Game.
- Theme: dinosaurs, space, trains, kitchen, animals, superheroes, construction, ocean.
- Level: auto, 1, 2, 3, 4, 5.
- Session length: 5, 8, 10, 15 minutes.
- Available materials: blocks, paper, crayons, snacks, toy cars, magnetic letters, stuffed toys, household objects.
- Audio: on/off.
- Microphone: off by default.

### Active Mission Screen

The active mission screen is the only screen the child should usually see.

Requirements:

- One large number, letter, shape, or icon.
- One short mission.
- Large speaker button.
- Parent controls visible but visually secondary.
- No scrolling.
- No feed.
- No autoplaying next mission without parent action.

Example:

```text
        4

Bring 4 tiny treasures.

[Play voice]

[Hint]        [We did it]
```

### Parent Checkpoint

Appears after the parent taps "We did it."

Parent records:

- Completed, helped, skipped, too easy, too hard.
- Optional note.
- Child answer if relevant.

The app then chooses:

- Repeat similar mission.
- Increase difficulty.
- Switch modality.
- End session if time is up.

### Session Recap

Parent-only.

Content:

- Time played.
- Skills practiced.
- What seemed easy.
- What stretched him.
- Suggested next session.
- Offline extension activity.

Example:

```text
8-minute quest complete

Practiced:
Counting 1-5, comparing more/less, following 2-step directions.

Next time:
Try "give away 1" subtraction stories with blocks.
```

## 9. Game Catalog

### Game 1: Treasure Hunt

Core idea: The child finds real objects in the room based on count, shape, color, category, texture, or sound.

Primary skills:

- Counting.
- Classification.
- Shapes and colors.
- Vocabulary.
- Movement.

Materials:

- Any room objects.
- Optional basket or tray.

Gameplay:

1. AI generates a mission.
2. Child searches the room.
3. Parent verifies and counts with child.
4. App gives a related follow-up.

Example missions:

- "Find 3 round things."
- "Bring 2 things that are soft."
- "Find something bigger than your hand."
- "Put 4 treasures in a line."
- "Take away 1 treasure. How many are left?"

Levels:

- Level 1: Count 1-3, single attribute, visible nearby objects.
- Level 2: Count 1-5, colors/shapes, one-step missions.
- Level 3: Count 1-10, two attributes, compare more/less.
- Level 4: Simple addition/subtraction with objects.
- Level 5: Child creates a mission for the parent; introduces estimation and sorting by multiple attributes.

AI adaptation:

- If too easy, add a second attribute or larger number.
- If too hard, reduce count and offer examples.
- If child is highly engaged, add a pretend-play frame.

Success criteria:

- Child correctly counts objects with or without parent help.
- Child can explain why objects match the mission.

### Game 2: Letter Detective

Core idea: The child hunts for sounds, letters, rhymes, and words in the environment.

Primary skills:

- Letter recognition.
- Phonemic awareness.
- Beginning sounds.
- Vocabulary.
- Early reading confidence.

Materials:

- Magnetic letters, paper cards, books, labels, toys.

Gameplay:

1. Parent chooses a target letter or "surprise me."
2. AI gives a sound-based mission.
3. Child finds an object, letter card, or says a word.
4. Parent confirms.

Example missions:

- "Can you find something that starts with /b/?"
- "Point to the letter M."
- "Say a word that rhymes with cat."
- "Find a letter with straight lines."
- "Make the sound for S like a snake."

Levels:

- Level 1: Recognize uppercase letters in child's name or common letters.
- Level 2: Match letter to sound for high-frequency consonants.
- Level 3: Identify beginning sounds in objects.
- Level 4: Rhyming and syllable clapping.
- Level 5: Blend simple sounds orally, such as /m/ /a/ /t/.

AI adaptation:

- Favor letters from the child's name and interests.
- Avoid visually similar letters until ready, then introduce contrasts like b/d or p/q.
- Generate multisensory prompts: trace, clap, jump, whisper, draw.

Success criteria:

- Child identifies target sound or letter.
- Child attempts a word even if pronunciation is imperfect.

### Game 3: Math Story Buddy

Core idea: AI creates tiny math stories using the child's favorite themes, while the child solves with physical counters.

Primary skills:

- Number sense.
- Addition and subtraction.
- Comparing quantities.
- Mathematical language.
- Story comprehension.

Materials:

- Blocks, snacks, toy animals, cars, buttons, paper counters.

Gameplay:

1. Parent selects theme and number range.
2. AI narrates a short story.
3. Child acts it out with objects.
4. Parent checks answer.

Example missions:

- "Two rockets land on Mars. One more rocket arrives. How many rockets are there?"
- "Five dinosaurs are eating leaves. Two walk away. How many stay?"
- "You have 3 train cars. Add 2 more. Count them all."
- "Which plate has more berries?"

Levels:

- Level 1: Count and match quantities 1-3.
- Level 2: Count 1-5 and compare more/less/same.
- Level 3: Add one more, take one away.
- Level 4: Addition/subtraction within 10 using objects.
- Level 5: Missing addend stories, such as "We need 5 rockets. We have 3. How many more?"

AI adaptation:

- Use current favorite themes.
- Keep wording short.
- Offer "act it out" before asking for numeric answer.
- If child answers quickly, ask "How did you know?"

Success criteria:

- Child models story with objects.
- Child gives answer verbally, by pointing, or by arranging objects.

### Game 4: Pattern Robot

Core idea: The child builds and extends patterns using colors, shapes, sounds, movements, or objects.

Primary skills:

- Pattern recognition.
- Prediction.
- Sequencing.
- Early algebraic thinking.
- Working memory.

Materials:

- Blocks, crayons, beads, toy cars, body movements.

Gameplay:

1. AI suggests a pattern.
2. Parent builds the start or child builds from prompt.
3. Child predicts what comes next.
4. AI introduces a variation.

Example missions:

- "Red, blue, red, blue. What comes next?"
- "Clap, stomp, clap, stomp. Your turn."
- "Circle, square, circle, square."
- "Big, small, small, big, small, small."

Levels:

- Level 1: AB patterns with two colors or movements.
- Level 2: ABB and AAB patterns.
- Level 3: Shape/color combined patterns.
- Level 4: Missing item in a pattern.
- Level 5: Child invents a pattern and parent must solve it.

AI adaptation:

- Switch between visual, auditory, and movement patterns.
- Reduce pattern length when working memory is overloaded.
- Increase complexity only after two successful rounds.

Success criteria:

- Child extends pattern.
- Child can say or show the repeating unit.

### Game 5: Tiny Coding Adventure

Core idea: The child gives commands to move a toy, parent, or paper character through a floor/table maze.

Primary skills:

- Sequencing.
- Spatial reasoning.
- Direction following.
- Debugging.
- Early computational thinking.

Materials:

- Toy figure, paper grid, tape maze, blocks as obstacles.

Gameplay:

1. Parent creates a simple path or grid.
2. AI gives a destination.
3. Child chooses commands: forward, turn, jump, stop.
4. Parent moves the toy exactly as commanded.
5. Child debugs if needed.

Example missions:

- "Get the robot to the moon rock."
- "Move forward 2 steps, turn left, then forward 1."
- "The robot bumped into a block. What should we change?"
- "Can you give dad three commands?"

Levels:

- Level 1: One-step movement commands.
- Level 2: Two-step sequences.
- Level 3: Three-step sequences with turns.
- Level 4: Debug a wrong path.
- Level 5: Create a maze and write/draw a command plan.

AI adaptation:

- Generate commands based on grid size.
- Encourage debugging language: "try again," "change one step," "what happened?"
- Keep failure playful and low-stakes.

Success criteria:

- Child gives a command sequence.
- Child revises command after observing result.

### Game 6: Story Builder

Core idea: AI co-creates a story with the child, pausing frequently for choices, predictions, and retelling.

Primary skills:

- Oral language.
- Narrative structure.
- Vocabulary.
- Memory.
- Emotional reasoning.

Materials:

- Optional toys, drawings, stuffed animals.

Gameplay:

1. Child picks a hero, place, and object.
2. AI starts a 2-3 sentence story.
3. Child chooses what happens next.
4. Parent can ask recall and feeling questions.

Example missions:

- "The tiny train found a shiny key. Should it open the blue door or the green door?"
- "How do you think the dinosaur feels?"
- "Can you tell the story back to me?"
- "Draw the next part."

Levels:

- Level 1: Choose between two options.
- Level 2: Predict what happens next.
- Level 3: Retell beginning/middle/end.
- Level 4: Add a problem and solution.
- Level 5: Child becomes narrator; AI only asks questions.

AI adaptation:

- Use the child's words in the story.
- Keep turns short.
- Avoid scary, violent, or emotionally intense content.

Success criteria:

- Child contributes a choice, word, sentence, drawing, or action.
- Child recalls at least one story detail.

## 10. Levels and Progression

Levels are per skill, not global. A child can be Level 5 in counting and Level 2 in letter sounds.

### Level Bands

- Level 1: Discover
  - Adult models heavily.
  - Numbers 1-3.
  - Single-step prompts.
  - Recognition over production.

- Level 2: Join In
  - Child responds with pointing, bringing, repeating, or choosing.
  - Numbers 1-5.
  - Simple matching and naming.

- Level 3: Try It
  - Child explains or demonstrates.
  - Numbers 1-10.
  - Two-step prompts.
  - Beginning transformations: add one, remove one, change pattern.

- Level 4: Reason
  - Child solves simple problems.
  - Uses objects to represent thinking.
  - Can recover from a mistake with a hint.

- Level 5: Create
  - Child invents missions, stories, patterns, or mazes.
  - Parent becomes player.
  - AI asks reflective questions.

### Progression Rules

- Increase difficulty after two comfortable completions in a row.
- Decrease difficulty after frustration, repeated guessing, or parent "too hard."
- Rotate modalities every 2-3 missions: movement, object search, verbal, drawing/building.
- End with a success mission, not the hardest mission.

## 11. Safety, Privacy, and Compliance

### Child Safety

- No open-ended child chat.
- No external links in child-facing views.
- No ads, autoplay, or infinite feeds.
- No adult topics, violence, fear-based content, body-image content, or moralizing feedback.
- Parent can instantly mute, skip, or end session.

### Privacy

- No child account in MVP.
- Store session summaries locally by default.
- Microphone off by default.
- Do not store raw audio, images, or transcripts unless parent explicitly opts in.
- If cloud storage is introduced, provide parent review and delete controls.
- If distributed publicly in the US, evaluate COPPA obligations before launch.

### AI Data Handling

- Strip personal identifiers from AI prompts.
- Send only learning context needed for the mission.
- Avoid sending child voice or images to AI providers unless parent enables the feature.
- Provide a "local-only mode" that uses static mission packs and browser TTS.

## 12. Interface Design

### Visual Direction

- Calm, warm, tactile.
- Inspired by paper cards, blocks, felt, crayons, and storybooks.
- Large type, soft contrast, clear icons.
- Minimal animation.
- No overwhelming color palette.

### Child-Facing UI Requirements

- Single task per screen.
- 1-2 lines of text.
- Large numeral/letter/shape when relevant.
- Audio button.
- Parent action buttons no smaller than 44px high.
- No menu visible to child during active play.

### Parent-Facing UI Requirements

- Fast setup.
- Clear settings.
- Ability to choose theme/materials.
- Ability to override AI level.
- Review of why a mission was suggested.
- Session recap with next-step recommendations.

### Accessibility

- Every mission available as text and audio.
- High-contrast mode.
- Reduced motion setting.
- Large tap targets.
- Keyboard navigable parent UI.
- Captions/transcript for voice output.

## 13. MVP Scope

### Included in MVP

- Responsive web app.
- Parent Home.
- Start Quest flow.
- Three games:
  - Treasure Hunt.
  - Letter Detective.
  - Math Story Buddy.
- Five-level progression model.
- AI-generated mission packs via reasoning provider.
- Schema-validated AI responses.
- Browser TTS fallback.
- Parent checkpoint after every mission.
- Session recap.
- Local history for last 10 sessions.
- Settings:
  - Session length.
  - Theme.
  - Materials.
  - Voice on/off.
  - AI provider/model env configuration.

### Post-MVP

- Pattern Robot.
- Tiny Coding Adventure.
- Story Builder.
- Optional STT.
- Optional parent photo/vision verification.
- Printable mission cards.
- Multiple child profiles, parent-controlled.
- Teacher/therapist export mode.
- Offline/static mission pack mode.

## 14. User Stories

- As a parent, I can start a 5-minute counting game in under 30 seconds.
- As a parent, I can choose a theme my child loves.
- As a parent, I can keep the microphone disabled.
- As a parent, I can see why the app made the next mission easier or harder.
- As a child, I can hear the mission read aloud.
- As a child, I can complete the game by moving around the room, not by tapping repeatedly.
- As a parent, I can end the session and get a useful next suggestion.
- As a developer, I can swap the reasoning model without changing game logic.
- As a developer, I can add a new game using the same mission schema.

## 15. Key Flows

### Flow 1: Start a Quest

1. Parent opens app.
2. Taps "Start Quest."
3. Chooses "Treasure Hunt."
4. Selects "Space," "5 minutes," "Level Auto."
5. Taps "Start."
6. App generates 5-7 missions.
7. Active Mission screen appears.

### Flow 2: Complete a Mission

1. App reads: "Find 3 round things."
2. Child searches room.
3. Parent taps "We did it."
4. Parent marks "completed" or "helped."
5. App adapts next mission.

### Flow 3: End Session

1. Time expires or parent taps "End."
2. App shows recap.
3. Parent can save locally.
4. App suggests next quest.

## 16. Data Model

```ts
type SkillArea =
  | "counting"
  | "letter_sounds"
  | "letter_recognition"
  | "shape_color"
  | "patterns"
  | "story_math"
  | "sequencing"
  | "oral_language";

type LevelId = 1 | 2 | 3 | 4 | 5 | "auto";

type GameId =
  | "treasure_hunt"
  | "letter_detective"
  | "math_story_buddy"
  | "pattern_robot"
  | "tiny_coding_adventure"
  | "story_builder";

type SessionRecord = {
  id: string;
  startedAt: string;
  endedAt?: string;
  gameId: GameId;
  theme: string;
  levelStart: LevelId;
  materials: string[];
  missions: MissionAttempt[];
};

type MissionAttempt = {
  mission: Mission;
  outcome: "completed" | "helped" | "skipped" | "too_easy" | "too_hard";
  parentNote?: string;
  childAnswer?: string;
  durationSeconds?: number;
};

type ParentSummary = {
  headline: string;
  practicedSkills: SkillArea[];
  observedStrengths: string[];
  stretchPoints: string[];
  nextQuestSuggestion: {
    gameId: GameId;
    level: LevelId;
    reason: string;
  };
  offlineActivity: string;
};
```

## 17. Prompting Strategy

### Mission Generation Prompt Requirements

The reasoning model receives:

- Game ID.
- Age range.
- Skill level.
- Theme.
- Available materials.
- Session length.
- Prior mission outcomes.

The reasoning model returns:

- Strict JSON schema.
- 5-7 missions.
- Short spoken prompts.
- Parent-only explanation.
- Hints and extensions.
- Safety flags.

### Example System Instruction

```text
You generate preschool learning missions for parent-led physical-world play.
The child is 4 years old. Keep prompts short, warm, concrete, and safe.
Do not ask for personal information. Do not create open-ended chatbot behavior.
Every mission must be doable with real objects and parent supervision.
Return only valid JSON matching the schema.
```

### Example Mission Output

```json
{
  "id": "mission_01",
  "spokenPrompt": "Find 3 round things.",
  "parentPrompt": "Count each object with him. Ask why each one is round.",
  "expectedResponseType": "object",
  "targetSkill": "counting",
  "difficulty": 2,
  "safetyFlags": [],
  "successCriteria": [
    "Child brings or points to 3 objects",
    "Child counts with one-to-one correspondence"
  ],
  "hint": "Try looking for a ball, plate, or lid.",
  "extension": "Now find 1 more. How many do you have?"
}
```

## 18. Metrics

### Product Metrics

- Quest start rate.
- Average setup time.
- Average session length.
- Sessions completed before timeout.
- Parent "worth doing again" rating.
- Percentage of missions completed away from screen.

### Learning/Engagement Signals

- Parent-marked completed/helped/skipped.
- Too easy/too hard rate.
- Number of successful missions before frustration.
- Skills practiced over time.
- Parent notes.

### Safety/Trust Metrics

- Parent skips due to inappropriate mission.
- AI schema validation failures.
- Provider failures/fallbacks.
- Microphone enabled rate.
- Data deletion usage if cloud history exists.

## 19. Acceptance Criteria

### MVP Acceptance Criteria

- Parent can start a Treasure Hunt session in under 30 seconds.
- App can generate schema-valid missions for each MVP game.
- Child-facing mission screen contains only one mission and core controls.
- Parent can mark outcome after every mission.
- App adapts difficulty based on parent feedback.
- App produces a useful recap after session end.
- Browser TTS works without configuring an external voice provider.
- Reasoning provider can be swapped through configuration.
- No raw child audio/image is stored in MVP.
- App works on mobile, tablet, and desktop viewport sizes.

## 20. Open Questions

- Should MVP have parent login, or should it be entirely local-first?
- Should the first build target phone-in-parent-hand or tablet-on-table as the primary viewport?
- Should child voice input wait until after strong privacy controls and provider configuration are complete?
- Should the app include printable cards from day one?
- What are the first 5 themes the child will care about most?
- Should gifted-child progression include Level 6+ extensions, or should Level 5 creation mode cover that need?

## 21. References

- American Academy of Pediatrics / HealthyChildren.org: screen use for preschoolers should be managed intentionally, with co-viewing/co-play and healthy non-screen activities prioritized: https://www.healthychildren.org/English/family-life/Media/Pages/Where-We-Stand-TV-Viewing-Time.aspx
- NAEYC: preschool children learn through creativity, movement, play materials, and developmentally appropriate interactive media: https://www.naeyc.org/resources/topics/technology-and-media/preschoolers-and-kindergartners
- FTC children's privacy guidance: COPPA gives parents control over information collected from children: https://www.ftc.gov/business-guidance/privacy-security/childrens-privacy
- Vercel AI SDK: provider-agnostic TypeScript toolkit with unified API for model providers: https://github.com/vercel/ai
