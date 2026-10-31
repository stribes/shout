(() => {
	const MAX_LEN = 140;
	const MAX_SHOUTS = 500;

	const REPLAY_SPEEDS = [1, 2, 5, 10, 30, 60, 100, 200];
	const REPLAY_MIN_DELAY = 10;
	const REPLAY_MAX_DELAY = 10000;
	const REPLAY_MIN_FRAME_MS = 16;
	const MAX_CONSECUTIVE_MISSES = 25;

	const PALETTE = ['#e87552', '#528ccb', '#91b84a', '#e0ad3d', '#a77ad1', '#40a995', '#d45c7a'];

	const cloud = document.getElementById('cloud');
	const form = document.getElementById('shout-form');
	const textarea = document.getElementById('text');
	const counter = document.getElementById('counter');
	const statusEl = document.getElementById('status');
	const button = form.querySelector('button');
	const emptyState = document.getElementById('empty-state');

	const archivesEl = document.getElementById('archives');
	const archiveLabel = document.getElementById('archive-label');
	const olderButton = document.getElementById('older');
	const newerButton = document.getElementById('newer');
	const showAllButton = document.getElementById('show-all');
	const liveButton = document.getElementById('live');

	const replayCount = document.getElementById('replay-count');
	const replaySpeedButton = document.getElementById('replay-speed');
	const replayTrack = document.getElementById('replay-track');
	const replayProgress = document.getElementById('replay-progress');

	let socket = null;
	let liveShouts = [];
	let archiveShouts = [];
	let archives = [];
	let viewingArchive = null;
	let requestedArchiveId = null;
	let freshId = null;

	let reconnectTimer = null;
	let reconnectDelay = 1000;
	let resizeTimer = null;

	let replayItems = [];
	let replayIndex = 0;
	let replayElapsed = 0;
	let replayLastTick = 0;
	let replayTimer = null;
	let replaySpeedIndex = 0;
	let replayRunning = false;

	function hash(value) {
		let result = 2166136261;

		for (let i = 0; i < value.length; i++) {
			result ^= value.charCodeAt(i);
			result = Math.imul(result, 16777619);
		}

		return result >>> 0;
	}

	function rng(seed) {
		let a = seed >>> 0;

		return () => {
			a += 0x6d2b79f5;

			let t = a;
			t = Math.imul(t ^ (t >>> 15), t | 1);
			t ^= t + Math.imul(t ^ (t >>> 7), t | 61);

			return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
		};
	}

	function intersects(a, b) {
		return a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
	}

	function inflate(rect, padding) {
		return {
			left: rect.left - padding,
			top: rect.top - padding,
			right: rect.right + padding,
			bottom: rect.bottom + padding,
		};
	}

	function setStatus(message, isError = false) {
		statusEl.textContent = message;
		statusEl.classList.toggle('error', isError);
	}

	function setConnection(connected) {
		button.disabled = !connected;
	}

	function hideReplayControls() {
		replayCount.hidden = true;
		replaySpeedButton.hidden = true;
		replayTrack.hidden = true;
	}

	function clearReplay() {
		if (replayTimer !== null) {
			clearTimeout(replayTimer);
		}

		replayTimer = null;
		replayItems = [];
		replayIndex = 0;
		replayElapsed = 0;
		replayLastTick = 0;
		replayRunning = false;

		hideReplayControls();
	}

	function updateReplayProgress() {
		const total = replayItems.length;
		const progress = total === 0 ? 0 : (replayIndex / total) * 100;

		replayCount.textContent = `${replayIndex} / ${total}`;

		replayProgress.style.width = `${progress}%`;

		replayTrack.setAttribute('aria-valuenow', String(Math.round(progress)));

		replaySpeedButton.textContent = `${REPLAY_SPEEDS[replaySpeedIndex]}x`;
	}

	function render(shouts) {
		cloud.querySelectorAll('.tag').forEach((element) => {
			element.remove();
		});

		const width = window.innerWidth;
		const height = window.innerHeight;
		const mobile = width < 600;

		const formRect = form.getBoundingClientRect();

		const occupied = [
			inflate(
				{
					left: formRect.left,
					top: formRect.top,
					right: formRect.right,
					bottom: formRect.bottom,
				},
				14,
			),
		];

		const sorted = [...shouts].sort((a, b) => b.createdAt - a.createdAt);

		emptyState.classList.toggle('hidden', sorted.length > 0 || replayItems.length > 0);

		let misses = 0;

		for (let index = 0; index < sorted.length; index++) {
			if (misses >= MAX_CONSECUTIVE_MISSES) {
				break;
			}

			const shout = sorted[index];
			const random = rng(hash(shout.id));
			const freshness = 1 - index / Math.max(sorted.length, 1);

			const element = document.createElement('span');

			element.className = 'tag';
			element.dataset.id = shout.id;
			element.textContent = shout.content;

			const colour = PALETTE[Math.floor(random() * PALETTE.length)];

			const rotation = (random() - 0.5) * 16;
			const opacity = 0.45 + 0.55 * freshness;

			element.style.color = colour;
			element.style.opacity = opacity;
			element.style.transform = `rotate(${rotation}deg)`;

			if (shout.content.length > 30) {
				element.style.whiteSpace = 'normal';
				element.style.width = `${Math.min(mobile ? 190 : 280, width * 0.55)}px`;
			}

			cloud.appendChild(element);

			let fontSize = (mobile ? 12 : 15) + (mobile ? 12 : 24) * freshness;

			let placed = false;

			for (let sizeAttempt = 0; sizeAttempt < 4 && !placed; sizeAttempt++, fontSize *= 0.8) {
				element.style.fontSize = `${fontSize}px`;

				const box = element.getBoundingClientRect();

				if (box.width > width - 12 || box.height > height - 12) {
					continue;
				}

				for (let attempt = 0; attempt < 80; attempt++) {
					const x = 6 + random() * Math.max(0, width - box.width - 12);

					const y = 6 + random() * Math.max(0, height - box.height - 12);

					const rect = {
						left: x,
						top: y,
						right: x + box.width,
						bottom: y + box.height,
					};

					const padded = inflate(rect, 5);

					if (occupied.every((other) => !intersects(padded, other))) {
						element.style.left = `${x}px`;
						element.style.top = `${y}px`;

						occupied.push(rect);
						placed = true;

						if (shout.id === freshId) {
							element.classList.add('fresh');
						}

						break;
					}
				}
			}

			if (placed) {
				misses = 0;
			} else {
				element.remove();
				misses++;
			}
		}
	}

	function layout(replay = false) {
		clearReplay();

		const shouts = viewingArchive ? archiveShouts : liveShouts;

		if (replay && shouts.length > 0) {
			freshId = null;
			scheduleReplay(shouts);
			return;
		}

		render(shouts);

		freshId = null;
	}

	function scheduleReplay(shouts) {
		const ordered = [...shouts].sort((a, b) => a.createdAt - b.createdAt);

		replayItems = [];

		let elapsed = 0;
		let previous = null;

		ordered.forEach((shout) => {
			if (previous !== null) {
				const gap = shout.createdAt - previous;

				elapsed += Math.min(REPLAY_MAX_DELAY, Math.max(REPLAY_MIN_DELAY, gap));
			}

			previous = shout.createdAt;

			replayItems.push({
				shout,
				at: elapsed,
			});
		});

		replayIndex = 0;
		replayElapsed = 0;
		replaySpeedIndex = viewingArchive ? 0 : REPLAY_SPEEDS.length - 1;
		replayLastTick = performance.now();
		replayRunning = replayItems.length > 0;

		replayCount.hidden = !replayRunning;
		replaySpeedButton.hidden = !replayRunning;
		replayTrack.hidden = !replayRunning;

		render([]);

		updateReplayProgress();

		advanceReplay();
	}

	function advanceReplay() {
		if (!replayRunning) {
			return;
		}

		const now = performance.now();

		replayElapsed += (now - replayLastTick) * REPLAY_SPEEDS[replaySpeedIndex];

		replayLastTick = now;

		let revealed = replayIndex;

		while (revealed < replayItems.length && replayItems[revealed].at <= replayElapsed) {
			revealed++;
		}

		if (revealed !== replayIndex) {
			replayIndex = revealed;

			freshId = replayItems[revealed - 1].shout.id;

			render(replayItems.slice(0, revealed).map((item) => item.shout));

			freshId = null;
		}

		updateReplayProgress();

		if (replayIndex >= replayItems.length) {
			replayRunning = false;
			replayTimer = null;
			hideReplayControls();
			return;
		}

		const next = replayItems[replayIndex];
		const remaining = next.at - replayElapsed;

		replayTimer = setTimeout(advanceReplay, Math.max(REPLAY_MIN_FRAME_MS, remaining / REPLAY_SPEEDS[replaySpeedIndex]));
	}

	function increaseReplaySpeed() {
		if (replayItems.length === 0) {
			return;
		}

		if (replayRunning) {
			const now = performance.now();

			replayElapsed += (now - replayLastTick) * REPLAY_SPEEDS[replaySpeedIndex];

			replayLastTick = now;

			if (replayTimer !== null) {
				clearTimeout(replayTimer);
				replayTimer = null;
			}
		}

		replaySpeedIndex = (replaySpeedIndex + 1) % REPLAY_SPEEDS.length;

		updateReplayProgress();

		if (replayRunning) {
			advanceReplay();
		}
	}

	function revealAll() {
		if (replayItems.length === 0) {
			return;
		}

		if (replayTimer !== null) {
			clearTimeout(replayTimer);
		}

		replayTimer = null;
		replayRunning = false;
		replayIndex = replayItems.length;

		freshId = null;

		render(replayItems.map((item) => item.shout));

		updateReplayProgress();
		hideReplayControls();
	}

	function addShout(shout) {
		if (!shout || typeof shout.id !== 'string') {
			return;
		}

		const existing = liveShouts.findIndex((item) => item.id === shout.id);

		if (existing !== -1) {
			liveShouts[existing] = shout;
		} else {
			liveShouts.push(shout);
		}

		liveShouts.sort((a, b) => a.createdAt - b.createdAt);

		if (liveShouts.length > MAX_SHOUTS) {
			liveShouts = liveShouts.slice(-MAX_SHOUTS);
		}

		if (!viewingArchive) {
			freshId = shout.id;
			layout();
		}
	}

	function archiveIndex() {
		return viewingArchive ? archives.findIndex((archive) => archive.id === viewingArchive.id) : -1;
	}

	function updateArchives() {
		const index = archiveIndex();

		archivesEl.classList.toggle('hidden', archives.length === 0);

		if (viewingArchive) {
			archiveLabel.textContent = `archive ${viewingArchive.number} / ${archives.length}`;

			archiveLabel.title = new Date(viewingArchive.createdAt).toLocaleString();
		} else {
			archiveLabel.textContent = 'live';
			archiveLabel.title = 'the current wall';
		}

		olderButton.disabled = archives.length === 0 || (viewingArchive !== null && index <= 0);

		newerButton.disabled = !viewingArchive || index < 0 || index >= archives.length - 1;

		showAllButton.classList.toggle('hidden', !viewingArchive);

		liveButton.classList.toggle('hidden', !viewingArchive);
	}

	function openArchive(archive) {
		if (!archive || !socket || socket.readyState !== WebSocket.OPEN) {
			return;
		}

		requestedArchiveId = archive.id;

		socket.send(
			JSON.stringify({
				type: 'archive',
				id: archive.id,
			}),
		);
	}

	function showOlderArchive() {
		if (archives.length === 0) {
			return;
		}

		const index = archiveIndex();

		openArchive(viewingArchive ? archives[index - 1] : archives[archives.length - 1]);
	}

	function showNewerArchive() {
		const index = archiveIndex();

		if (index < 0 || index >= archives.length - 1) {
			return;
		}

		openArchive(archives[index + 1]);
	}

	function goLive() {
		requestedArchiveId = null;
		viewingArchive = null;
		archiveShouts = [];
		freshId = null;

		layout();
		updateArchives();
		setStatus('');
	}

	function handleMessage(event) {
		let data;

		try {
			data = JSON.parse(event.data);
		} catch {
			return;
		}

		switch (data.type) {
			case 'history':
				if (Array.isArray(data.shouts)) {
					liveShouts = data.shouts;
				}

				if (Array.isArray(data.archives)) {
					archives = data.archives;
				}

				if (!viewingArchive) {
					layout(true);
				}

				updateArchives();
				break;

			case 'shout':
				addShout(data.shout);
				break;

			case 'rollover':
				if (data.archive && typeof data.archive.id === 'string') {
					if (!archives.some((archive) => archive.id === data.archive.id)) {
						archives.push(data.archive);

						archives.sort((a, b) => a.number - b.number);
					}
				}

				liveShouts = [];

				if (!viewingArchive) {
					freshId = null;
					layout();
				}

				updateArchives();

				setStatus('the wall rolled over, the last 100 are archived');
				break;

			case 'archive':
				if (!data.archive || typeof data.archive.id !== 'string' || data.archive.id !== requestedArchiveId) {
					return;
				}

				requestedArchiveId = null;
				viewingArchive = data.archive;

				archiveShouts = Array.isArray(data.shouts) ? data.shouts : [];

				updateArchives();
				layout(true);
				setStatus('');
				break;

			case 'error':
				setStatus(data.message || 'Something went wrong.', true);
				break;
		}
	}

	function connect() {
		clearTimeout(reconnectTimer);

		const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';

		socket = new WebSocket(`${protocol}//${window.location.host}/ws`);

		window.socket = socket;

		socket.addEventListener('open', () => {
			reconnectDelay = 1000;
			setConnection(true);
		});

		socket.addEventListener('message', handleMessage);

		socket.addEventListener('close', () => {
			setConnection(false);

			reconnectTimer = setTimeout(connect, reconnectDelay);

			reconnectDelay = Math.min(reconnectDelay * 2, 15000);
		});

		socket.addEventListener('error', () => {
			socket.close();
		});
	}

	textarea.addEventListener('input', () => {
		const length = [...textarea.value].length;

		counter.textContent = `${length} / ${MAX_LEN}`;
	});

	textarea.addEventListener('keydown', (event) => {
		if (event.key === 'Enter' && !event.shiftKey) {
			event.preventDefault();
			form.requestSubmit();
		}
	});

	form.addEventListener('submit', (event) => {
		event.preventDefault();

		const content = textarea.value.trim();

		if (!content || !socket || socket.readyState !== WebSocket.OPEN) {
			return;
		}

		if ([...content].length > MAX_LEN) {
			setStatus("That's a little too long.", true);
			return;
		}

		socket.send(
			JSON.stringify({
				type: 'shout',
				content,
			}),
		);

		textarea.value = '';
		counter.textContent = `0 / ${MAX_LEN}`;

		setStatus('Shouted into the world!');
		textarea.focus();
	});

	olderButton.addEventListener('click', showOlderArchive);
	newerButton.addEventListener('click', showNewerArchive);
	showAllButton.addEventListener('click', revealAll);
	liveButton.addEventListener('click', goLive);

	replaySpeedButton.addEventListener('click', increaseReplaySpeed);

	window.addEventListener('resize', () => {
		clearTimeout(resizeTimer);

		resizeTimer = setTimeout(layout, 150);
	});

	connect();
})();
