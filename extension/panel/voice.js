// Safari handles microphone permission, recognition and playback. Only finalized
// text enters the composer or the existing, account-bound conversation.
export function createVoice({ platform = window, update, insert, submit, report }) {
  const Recognition = platform.SpeechRecognition || platform.webkitSpeechRecognition;
  const synth = platform.speechSynthesis;
  let session;
  function show(s, phase, text = "") {
    s.phase = phase;
    update(s.mode, phase, text);
  }
  function stop() {
    const s = session;
    if (!s) return;
    session = null;
    clearTimeout(s.timer);
    try { s.recognition?.abort(); } catch {}
    if (s.utterance) synth?.cancel();
    update(null, null, "");
  }
  function fail(s, message) {
    if (s !== session) return;
    stop(); report(message);
  }
  function listen(s) {
    if (s !== session) return;
    let rec;
    try { rec = new Recognition(); } catch { return fail(s, "Safari could not start speech recognition."); }
    s.recognition = rec;
    rec.lang = platform.navigator.language;
    rec.continuous = s.mode === "dictate";
    rec.interimResults = true;
    show(s, "starting");
    let next = 0, words = "";
    const current = () => s === session && s.recognition === rec;
    rec.onstart = () => {
      if (!current()) return;
      clearTimeout(s.timer); show(s, "listening");
    };
    rec.onresult = event => {
      if (!current()) return;
      let interim = "";
      for (let i = next; i < event.results.length; i++) {
        const part = event.results[i][0].transcript.trim();
        if (!event.results[i].isFinal) { interim += " " + part; continue; }
        next = i + 1;
        if (!part) continue;
        if (s.mode === "dictate") insert(part);
        else {
          words = [words, part].filter(Boolean).join(" ");
          if (words.length > 12000) return fail(s, "That voice turn exceeded the message limit. Try a shorter turn.");
        }
      }
      show(s, "listening", (interim.trim() || words).slice(-160));
    };
    rec.onerror = event => {
      if (!current()) return;
      const errors = {
        "not-allowed": "Safari denied microphone or speech recognition access. Check the website’s microphone permission and enable Siri or Dictation in System Settings.",
        "service-not-allowed": "Speech recognition is unavailable here. Check Siri or Dictation in System Settings and Safari’s website permissions.",
        "audio-capture": "Safari could not capture audio. Check the selected microphone.",
        "no-speech": "No speech was detected.",
        network: "The speech recognition service could not be reached.",
      };
      fail(s, errors[event.error] || "Speech recognition stopped (" + event.error + ").");
    };
    rec.onend = () => {
      if (!current()) return;
      s.recognition = null; clearTimeout(s.timer);
      if (s.mode === "dictate") { stop(); return; }
      if (!words) return fail(s, "No speech was detected. Start Voice to try again.");
      show(s, "waiting");
      Promise.resolve().then(() => {
        if (session === s) return submit(words);
      }).catch(error => fail(s, error.message));
    };
    s.timer = setTimeout(() => fail(s, "Safari did not start the microphone. Check the microphone permission for this website."), 45000);
    try { rec.start(); } catch (error) { fail(s, error.message || "Safari could not start the microphone."); }
  }
  function speak(s, text) {
    show(s, "speaking");
    // Keep a single short utterance queued so ending Voice interrupts promptly.
    let rest = text.trim();
    function next() {
      if (s !== session) return;
      if (!rest) { s.utterance = null; listen(s); return; }
      const head = rest.slice(0, 250);
      const space = head.lastIndexOf(" ");
      const length = head.length < rest.length && space > 0 ? space : head.length;
      const line = new platform.SpeechSynthesisUtterance(rest.slice(0, length));
      rest = rest.slice(length).trimStart();
      line.lang = platform.navigator.language;
      line.onend = next;
      line.onerror = event => fail(s, "Voice playback stopped (" + event.error + ").");
      s.utterance = line;
      try { synth.speak(line); } catch (error) { fail(s, error.message); }
    }
    next();
  }
  return {
    get mode() { return session?.mode; },
    get phase() { return session?.phase; },
    toggle(mode) {
      if (session?.mode === mode) {
        if (mode === "dictate" && session.recognition && session.phase === "listening") {
          try { session.recognition.stop(); } catch { stop(); }
        } else stop();
        return;
      }
      stop();
      if (!Recognition) return report("Speech recognition is unavailable in this Safari session. Check that Siri or Dictation is enabled on this Mac.");
      if (mode === "voice" && (!synth || !platform.SpeechSynthesisUtterance)) return report("Speech playback is unavailable in this Safari session.");
      session = { mode };
      // The first speak runs inside the toolbar click to unlock Safari audio.
      if (mode === "voice") speak(session, "Voice started.");
      else listen(session);
    },
    reply(text, failed) {
      if (session?.mode !== "voice" || session.phase !== "waiting") return;
      if (failed || !text) stop();
      else speak(session, text);
    },
    stop,
  };
}
