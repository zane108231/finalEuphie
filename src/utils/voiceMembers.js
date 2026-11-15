function isHumanVoiceMember(member) {
    const user = member?.user;
    return Boolean(user && user.bot === false && user.system !== true);
}

function getHumanVoiceMembers(guild, voiceChannel) {
    const voiceStates = guild?.voiceStates?.cache;
    if (voiceStates) {
        const members = [];
        for (const [userId, state] of voiceStates) {
            if (state.channelId !== voiceChannel?.id) continue;
            const member = state.member || guild.members?.cache?.get(userId);
            if (isHumanVoiceMember(member)) members.push(member);
        }
        return members;
    }

    return [...(voiceChannel?.members?.values?.() || [])].filter(
        isHumanVoiceMember
    );
}

module.exports = { getHumanVoiceMembers, isHumanVoiceMember };
